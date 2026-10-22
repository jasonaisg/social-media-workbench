package wxmp

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"strings"
	"time"
)

const NativeOfficialAccountHistoryClientTitlePrefix = "微信公众号历史桥接:"

const nativeOfficialAccountHistoryCredentialsTTL = 30 * time.Minute

var officialAccountBizPattern = regexp.MustCompile(`^[A-Za-z0-9_-]+={0,2}$`)

type frontendOfficialAccountHistoryResponse struct {
	ErrCode int             `json:"errCode"`
	ErrMsg  string          `json:"errMsg"`
	Data    json.RawMessage `json:"data"`
}

type nativeOfficialAccountHistoryCredentials struct {
	Biz        string    `json:"biz"`
	Uin        string    `json:"uin"`
	Key        string    `json:"key"`
	PassTicket string    `json:"pass_ticket"`
	CapturedAt time.Time `json:"-"`
}

func normalizeOfficialAccountHistoryBiz(value string) (string, error) {
	biz := strings.TrimSpace(value)
	if biz == "" || len(biz) > 256 || !officialAccountBizPattern.MatchString(biz) {
		return "", new_scraper_error(ErrorKindInvalidArgument, ErrorMessage(ErrorKindInvalidArgument), errors.New("invalid official-account biz"))
	}
	return biz, nil
}

func officialAccountHistoryURL(rawURL string, biz string) (string, error) {
	normalizedBiz, err := normalizeOfficialAccountHistoryBiz(biz)
	if err != nil {
		return "", err
	}
	if strings.TrimSpace(rawURL) != "" {
		parsed, parseErr := url.Parse(strings.TrimSpace(rawURL))
		if parseErr != nil || !strings.EqualFold(parsed.Scheme, "https") || !strings.EqualFold(parsed.Hostname(), "mp.weixin.qq.com") {
			return "", new_scraper_error(ErrorKindInvalidArgument, ErrorMessage(ErrorKindInvalidArgument), errors.New("invalid official-account profile URL"))
		}
		profileBiz := strings.TrimSpace(parsed.Query().Get("__biz"))
		if profileBiz != "" && profileBiz != normalizedBiz {
			return "", new_scraper_error(ErrorKindInvalidArgument, ErrorMessage(ErrorKindInvalidArgument), errors.New("profile URL biz does not match account"))
		}
	}
	target := &url.URL{Scheme: "https", Host: "mp.weixin.qq.com", Path: "/mp/profile_ext", RawQuery: url.Values{
		"action": []string{"home"},
		"__biz":  []string{normalizedBiz},
		"scene":  []string{"124"},
	}.Encode(), Fragment: "wechat_redirect"}
	return target.String(), nil
}

// OpenNativeOfficialAccountHistory asks the connected native search page to
// open the classic profile WebView. That page owns the short-lived uin/key/
// pass_ticket required by WeChat's history endpoint.
func (c *OfficialAccountServer) OpenNativeOfficialAccountHistory(profileURL string, biz string) (json.RawMessage, error) {
	target, err := officialAccountHistoryURL(profileURL, biz)
	if err != nil {
		return nil, err
	}
	args, err := json.Marshal(map[string]any{"url": target, "openType": 1, "scene": 124})
	if err != nil {
		return nil, err
	}
	return c.CallJSAPIOnClientTitle(JSAPIRequest{
		Operation: "invoke",
		Method:    "openUrlWithExtraWebview",
		Args:      args,
		TimeoutMS: 8000,
	}, NativeArticleSearchClientTitle)
}

func (c *OfficialAccountServer) rememberNativeOfficialAccountHistoryCredentials(raw string) {
	var credentials nativeOfficialAccountHistoryCredentials
	if json.Unmarshal([]byte(raw), &credentials) != nil {
		return
	}
	biz, err := normalizeOfficialAccountHistoryBiz(credentials.Biz)
	credentials.Uin = strings.TrimSpace(credentials.Uin)
	credentials.Key = strings.TrimSpace(credentials.Key)
	credentials.PassTicket = strings.TrimSpace(credentials.PassTicket)
	if err != nil || credentials.Uin == "" || credentials.Key == "" || len(credentials.Uin) > 512 || len(credentials.Key) > 4096 || len(credentials.PassTicket) > 4096 {
		return
	}
	credentials.Biz = biz
	credentials.CapturedAt = time.Now()
	c.history_credentials_mu.Lock()
	if c.history_credentials == nil {
		c.history_credentials = make(map[string]nativeOfficialAccountHistoryCredentials)
	}
	c.history_credentials[biz] = credentials
	c.history_credentials_mu.Unlock()
}

func (c *OfficialAccountServer) nativeOfficialAccountHistoryCredentials(biz string) (nativeOfficialAccountHistoryCredentials, bool) {
	normalizedBiz, err := normalizeOfficialAccountHistoryBiz(biz)
	if err != nil {
		return nativeOfficialAccountHistoryCredentials{}, false
	}
	c.history_credentials_mu.RLock()
	credentials, ok := c.history_credentials[normalizedBiz]
	c.history_credentials_mu.RUnlock()
	if !ok || credentials.CapturedAt.IsZero() || time.Since(credentials.CapturedAt) > nativeOfficialAccountHistoryCredentialsTTL {
		return nativeOfficialAccountHistoryCredentials{}, false
	}
	return credentials, true
}

func (c *OfficialAccountServer) HasHealthyOfficialAccountHistory(biz string) bool {
	_, ok := c.nativeOfficialAccountHistoryCredentials(biz)
	return ok
}

func decodeOfficialAccountHistoryResponse(response json.RawMessage) (json.RawMessage, error) {
	var frontend frontendOfficialAccountHistoryResponse
	if err := json.Unmarshal(response, &frontend); err != nil {
		return nil, new_scraper_error(ErrorKindDataParse, ErrorMessage(ErrorKindDataParse), err)
	}
	if frontend.ErrCode != 0 {
		message := strings.TrimSpace(frontend.ErrMsg)
		if message == "" {
			message = fmt.Sprintf("公众号历史消息桥接错误：%d", frontend.ErrCode)
		}
		return nil, new_scraper_error(ErrorKindFetchMessage, message, errors.New(message))
	}
	if len(frontend.Data) == 0 || !json.Valid(frontend.Data) {
		return nil, new_scraper_error(ErrorKindDataParse, ErrorMessage(ErrorKindDataParse), errors.New("invalid official-account history data"))
	}
	return frontend.Data, nil
}

// FetchNativeOfficialAccountHistory fetches one history page through the
// WebView that belongs to the exact selected account.
func (c *OfficialAccountServer) FetchNativeOfficialAccountHistory(biz string, offset int) (json.RawMessage, error) {
	normalizedBiz, err := normalizeOfficialAccountHistoryBiz(biz)
	if err != nil || offset < 0 || offset > 100000 {
		if err != nil {
			return nil, err
		}
		return nil, new_scraper_error(ErrorKindInvalidArgument, ErrorMessage(ErrorKindInvalidArgument), errors.New("invalid official-account history offset"))
	}
	credentials, ok := c.nativeOfficialAccountHistoryCredentials(normalizedBiz)
	if !ok {
		return nil, new_scraper_error(ErrorKindClientNotReady, "公众号历史会话尚未就绪，请重新选择该公众号", nil)
	}
	response, err := c.FetchMessageList(FetchMessageListParams{
		Biz:        normalizedBiz,
		Offset:     offset,
		Uin:        credentials.Uin,
		Key:        credentials.Key,
		PassTicket: credentials.PassTicket,
	})
	if err != nil {
		return nil, err
	}
	data, err := json.Marshal(response)
	if err != nil {
		return nil, new_scraper_error(ErrorKindDataParse, ErrorMessage(ErrorKindDataParse), err)
	}
	return data, nil
}
