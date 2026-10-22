package wxmp

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

const nativeArticleSearchVersion = 0x4c7f887
const NativeArticleSearchClientTitle = "微信搜一搜桥接"

const (
	nativeOfficialAccountSearchBusinessType = "1"
	nativeArticleSearchBusinessType         = "2"
	nativeOfficialAccountProfileScene       = 19
	nativeOfficialAccountArticleTagType     = 4
	nativeOfficialAccountEmptyQuery         = "EMPTY_QUERY_PLACEHOLDER"
	nativeOfficialAccountArticleSortLatest  = "2"
)

// SearchNativeArticles asks the connected WeChat search XWorker to call the
// same CGI used by the desktop client's article category. It does not use a
// third-party web index.
func (c *OfficialAccountServer) SearchNativeArticles(keyword string, offset int, cookies string, searchID string, diffRequestID string) (json.RawMessage, error) {
	return c.searchNativeWechat(keyword, nativeArticleSearchBusinessType, offset, cookies, searchID, diffRequestID, "")
}

// SearchNativeOfficialAccountArticles uses WeChat's account-scoped article
// search request. The desktop client sends the same MatchUserList and
// BIZFEEDS tag when searching from an official-account profile. This keeps
// pagination inside one exact account instead of filtering a limited global
// search result after the fact.
func (c *OfficialAccountServer) SearchNativeOfficialAccountArticles(keyword string, username string, offset int, cookies string, searchID string, diffRequestID string) (json.RawMessage, error) {
	// Scene 19 interprets Keyword as an article full-text filter even when an
	// exact account is supplied in MatchUserList. WeChat's own account-feed
	// request uses this sentinel for an unfiltered query. Keeping it here (not
	// only in the caller) prevents any client from accidentally returning just
	// the articles that mention the account name.
	return c.searchNativeWechat(nativeOfficialAccountEmptyQuery, nativeArticleSearchBusinessType, offset, cookies, searchID, diffRequestID, username)
}

// SearchNativeOfficialAccounts asks the connected WeChat search XWorker to
// use the desktop client's official-account category. The response is kept as
// the native search JSON so callers can inspect the exact account card fields
// returned by the current WeChat version.
func (c *OfficialAccountServer) SearchNativeOfficialAccounts(keyword string, offset int, cookies string, searchID string, diffRequestID string) (json.RawMessage, error) {
	return c.searchNativeWechat(keyword, nativeOfficialAccountSearchBusinessType, offset, cookies, searchID, diffRequestID, "")
}

func nativeSearchRequestID() string {
	value := make([]byte, 16)
	if _, err := rand.Read(value); err == nil {
		return hex.EncodeToString(value)
	}
	return fmt.Sprintf("%d", time.Now().UnixNano())
}

func nativeSearchRequestBody(keyword string, businessType string, offset int, cookies string, searchID string, diffRequestID string) map[string]any {
	requestID := nativeSearchRequestID()
	if diffRequestID == "" {
		diffRequestID = requestID
	}
	requestBody := map[string]any{
		"Keyword":      keyword,
		"BusinessType": businessType,
		"Offset":       offset,
		"IsHomePage":   0,
		"CliVersion":   nativeArticleSearchVersion,
		"Scene":        20,
		"RequestId":    requestID,
		// This value is consumed by the injected bridge and removed before the
		// native CGI call. WeChat keeps the first request id as diffRequestId
		// throughout one paginated search session.
		"SphDiffRequestId": diffRequestID,
		"ExtReqParams":     []any{},
		"NumConditions":    []any{},
		"TagInfo":          map[string]any{},
		"MatchUserList":    []any{},
	}
	if cookies != "" {
		requestBody["Cookies"] = cookies
	}
	if searchID != "" {
		// The current WeChat search bundle emits both spellings.
		requestBody["SearchID"] = searchID
		requestBody["SearchId"] = searchID
		requestBody["searchID"] = searchID
		requestBody["searchId"] = searchID
	}
	return requestBody
}

func nativeOfficialAccountArticleSearchRequestBody(keyword string, username string, offset int, cookies string, searchID string, diffRequestID string) map[string]any {
	requestBody := nativeSearchRequestBody(keyword, nativeArticleSearchBusinessType, offset, cookies, searchID, diffRequestID)
	requestBody["Scene"] = nativeOfficialAccountProfileScene
	requestBody["IsHomePage"] = 0
	// The unfiltered account feed defaults to relevance ordering. That ordering
	// can scatter whole publication months across much later result pages even
	// though the UI eventually sorts the pages it has seen. WeChat's own
	// "最新发布" filter is docSortType=2; send it on every page so the native
	// cursor advances along the account's publication timeline instead.
	requestBody["ExtReqParams"] = []any{map[string]any{
		"key":        "docSortType",
		"text_value": `["` + nativeOfficialAccountArticleSortLatest + `"]`,
	}}
	requestBody["MatchUserList"] = []any{map[string]any{
		"MatchWord": "",
		"UserName":  username,
	}}
	requestBody["TagInfo"] = map[string]any{
		"TagText": keyword,
		"TagType": nativeOfficialAccountArticleTagType,
	}
	return requestBody
}

func (c *OfficialAccountServer) searchNativeWechat(keyword string, businessType string, offset int, cookies string, searchID string, diffRequestID string, username string) (json.RawMessage, error) {
	keyword = strings.TrimSpace(keyword)
	username = strings.TrimSpace(username)
	searchID = strings.TrimSpace(searchID)
	diffRequestID = strings.TrimSpace(diffRequestID)
	if keyword == "" || len([]rune(keyword)) > 100 || len(username) > 256 || offset < 0 || offset > 1000 || len(searchID) > 256 || len(diffRequestID) > 256 {
		return nil, new_scraper_error(ErrorKindInvalidArgument, ErrorMessage(ErrorKindInvalidArgument), errors.New("invalid native search parameters"))
	}
	requestBody := nativeSearchRequestBody(keyword, businessType, offset, cookies, searchID, diffRequestID)
	if username != "" {
		requestBody = nativeOfficialAccountArticleSearchRequestBody(keyword, username, offset, cookies, searchID, diffRequestID)
	}
	reqJSON, err := json.Marshal(requestBody)
	if err != nil {
		return nil, err
	}
	args, err := json.Marshal(map[string]any{
		"req_json":          string(reqJSON),
		"url":               "/cgi-bin/mmsearch-bin/mmpcwebsearch",
		"cgi_cmdid":         6423,
		"h5Version":         nativeArticleSearchVersion,
		"scope":             "search",
		"is_security_check": true,
	})
	if err != nil {
		return nil, err
	}
	response, err := c.CallJSAPIOnClientTitle(JSAPIRequest{Operation: "invoke", Method: "H5ExtTransfer", Args: args, TimeoutMS: 25000}, NativeArticleSearchClientTitle)
	if err != nil {
		return nil, err
	}
	payload, err := decodeNativeSearchResponse(response)
	if err != nil {
		return nil, err
	}
	return annotateNativeSearchResponse(payload, requestBody["RequestId"].(string), requestBody["SphDiffRequestId"].(string))
}

func annotateNativeSearchResponse(payload json.RawMessage, requestID string, diffRequestID string) (json.RawMessage, error) {
	var response map[string]any
	if err := json.Unmarshal(payload, &response); err != nil {
		return nil, err
	}
	response["_sphRequestId"] = requestID
	response["_sphDiffRequestId"] = diffRequestID
	return json.Marshal(response)
}

func decodeNativeArticleSearchResponse(response json.RawMessage) (json.RawMessage, error) {
	return decodeNativeSearchResponse(response)
}

func decodeNativeSearchResponse(response json.RawMessage) (json.RawMessage, error) {
	var wrapper struct {
		Result struct {
			ErrMsg    string `json:"err_msg"`
			JSAPIResp struct {
				Ret      int    `json:"ret"`
				ErrMsg   string `json:"error_msg"`
				RespJSON string `json:"resp_json"`
			} `json:"jsapi_resp"`
		} `json:"result"`
	}
	if err := json.Unmarshal(response, &wrapper); err != nil {
		return nil, fmt.Errorf("decode WeChat search bridge: %w", err)
	}
	bridge := wrapper.Result.JSAPIResp
	if bridge.Ret != 0 || bridge.RespJSON == "" {
		return nil, fmt.Errorf("WeChat native search rejected: ret=%d %s %s", bridge.Ret, bridge.ErrMsg, wrapper.Result.ErrMsg)
	}
	var payload struct {
		Json json.RawMessage `json:"Json"`
	}
	if err := json.Unmarshal([]byte(bridge.RespJSON), &payload); err != nil {
		return nil, fmt.Errorf("decode WeChat search response: %w", err)
	}
	if len(payload.Json) == 0 {
		return nil, errors.New("WeChat native search returned no result data")
	}
	if payload.Json[0] == '"' {
		var encoded string
		if err := json.Unmarshal(payload.Json, &encoded); err != nil {
			return nil, err
		}
		payload.Json = json.RawMessage(encoded)
	}
	if !json.Valid(payload.Json) {
		return nil, errors.New("WeChat native search returned invalid result data")
	}
	return payload.Json, nil
}
