package wxmp

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestDecodeNativeArticleSearchResponse(t *testing.T) {
	outer := map[string]any{"result": map[string]any{"jsapi_resp": map[string]any{
		"ret": 0, "resp_json": `{"Json":"{\"query\":\"AI\",\"data\":[]}"}`,
	}}}
	encoded, _ := json.Marshal(outer)
	got, err := decodeNativeArticleSearchResponse(encoded)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != `{"query":"AI","data":[]}` {
		t.Fatalf("unexpected native result: %s", got)
	}
}

func TestNativeArticleSearchStatusRequiresSearchBridge(t *testing.T) {
	server := &OfficialAccountServer{ws_clients: map[*WebsocketClient]bool{}}
	article := &WebsocketClient{title: "公众号文章", last_ping: time.Now().Unix()}
	server.ws_clients[article] = true
	if server.HasHealthyClientTitle(NativeArticleSearchClientTitle) {
		t.Fatal("ordinary article page must not satisfy native search readiness")
	}
	search := &WebsocketClient{title: NativeArticleSearchClientTitle, last_ping: time.Now().Unix()}
	server.ws_clients[search] = true
	if !server.HasHealthyClientTitle(NativeArticleSearchClientTitle) {
		t.Fatal("healthy search bridge was not detected")
	}
	search.last_ping = time.Now().Add(-2 * time.Minute).Unix()
	if server.HasHealthyClientTitle(NativeArticleSearchClientTitle) {
		t.Fatal("stale search bridge must not be reported ready")
	}
}

func TestDecodeNativeArticleSearchRejectsBridgeError(t *testing.T) {
	_, err := decodeNativeArticleSearchResponse([]byte(`{"result":{"jsapi_resp":{"ret":-1,"error_msg":"not authorized"}}}`))
	if err == nil || !strings.Contains(err.Error(), "not authorized") {
		t.Fatalf("expected bridge error, got %v", err)
	}
}

func TestNativeSearchBusinessTypes(t *testing.T) {
	if nativeOfficialAccountSearchBusinessType != "1" {
		t.Fatalf("unexpected official-account business type: %s", nativeOfficialAccountSearchBusinessType)
	}
	if nativeArticleSearchBusinessType != "2" {
		t.Fatalf("unexpected article business type: %s", nativeArticleSearchBusinessType)
	}
}

func TestNativeSearchRequestBodyCarriesPaginationSession(t *testing.T) {
	body := nativeSearchRequestBody("AI", nativeArticleSearchBusinessType, 38, "opaque", "search-session", "first-request")
	if body["SearchID"] != "search-session" || body["SearchId"] != "search-session" {
		t.Fatalf("missing search session spellings: %#v", body)
	}
	if body["Cookies"] != "opaque" || body["Offset"] != 38 {
		t.Fatalf("missing pagination state: %#v", body)
	}
	if requestID, _ := body["RequestId"].(string); requestID == "" {
		t.Fatalf("missing fresh request id: %#v", body)
	}
	if body["SphDiffRequestId"] != "first-request" {
		t.Fatalf("missing stable diff request id: %#v", body)
	}
}

func TestNativeOfficialAccountArticleSearchScopesTheNativeRequest(t *testing.T) {
	body := nativeOfficialAccountArticleSearchRequestBody(nativeOfficialAccountEmptyQuery, "gh_964f2103592a", 20, "opaque", "search-session", "first-request")
	if body["BusinessType"] != nativeArticleSearchBusinessType || body["Scene"] != nativeOfficialAccountProfileScene {
		t.Fatalf("unexpected account article search routing: %#v", body)
	}
	users, ok := body["MatchUserList"].([]any)
	if !ok || len(users) != 1 {
		t.Fatalf("missing exact account match: %#v", body["MatchUserList"])
	}
	match, ok := users[0].(map[string]any)
	if !ok || match["UserName"] != "gh_964f2103592a" || match["MatchWord"] != "" {
		t.Fatalf("unexpected exact account match: %#v", users[0])
	}
	tag, ok := body["TagInfo"].(map[string]any)
	if !ok || tag["TagType"] != nativeOfficialAccountArticleTagType || tag["TagText"] != nativeOfficialAccountEmptyQuery {
		t.Fatalf("unexpected account article tag: %#v", body["TagInfo"])
	}
	if body["Offset"] != 20 || body["Cookies"] != "opaque" || body["SearchID"] != "search-session" {
		t.Fatalf("missing account pagination session: %#v", body)
	}
	ext, ok := body["ExtReqParams"].([]any)
	if !ok || len(ext) != 1 {
		t.Fatalf("missing latest-publication filter: %#v", body["ExtReqParams"])
	}
	filter, ok := ext[0].(map[string]any)
	if !ok || filter["key"] != "docSortType" || filter["text_value"] != `["2"]` {
		t.Fatalf("unexpected latest-publication filter: %#v", ext[0])
	}
}

func TestNativeOfficialAccountArticleSearchUsesUnfilteredSentinel(t *testing.T) {
	// The request cannot reach a bridge in this unit test, but validating the
	// sentinel constant here documents the account-feed protocol discovered
	// from a real scene-19 response.
	if nativeOfficialAccountEmptyQuery != "EMPTY_QUERY_PLACEHOLDER" {
		t.Fatalf("unexpected account feed sentinel: %q", nativeOfficialAccountEmptyQuery)
	}
}

func TestAnnotateNativeSearchResponseCarriesBridgeSession(t *testing.T) {
	payload, err := annotateNativeSearchResponse(json.RawMessage(`{"offset":38}`), "next-request", "first-request")
	if err != nil {
		t.Fatal(err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(payload, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded["_sphRequestId"] != "next-request" || decoded["_sphDiffRequestId"] != "first-request" {
		t.Fatalf("missing annotated session ids: %#v", decoded)
	}
}
