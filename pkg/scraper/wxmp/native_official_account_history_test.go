package wxmp

import (
	"strings"
	"testing"
	"time"
)

func TestOfficialAccountHistoryURLIsCanonicalAndAccountBound(t *testing.T) {
	got, err := officialAccountHistoryURL("https://mp.weixin.qq.com/mp/getmasssendmsg?__biz=MzA3NDAyNzU2NQ%3D%3D", "MzA3NDAyNzU2NQ==")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(got, "/mp/profile_ext?") || !strings.Contains(got, "action=home") || !strings.Contains(got, "__biz=MzA3NDAyNzU2NQ%3D%3D") {
		t.Fatalf("unexpected history URL: %s", got)
	}
	if _, err := officialAccountHistoryURL("https://example.com/profile?__biz=MzA3NDAyNzU2NQ%3D%3D", "MzA3NDAyNzU2NQ=="); err == nil {
		t.Fatal("non-WeChat profile URL must be rejected")
	}
	if _, err := officialAccountHistoryURL("https://mp.weixin.qq.com/mp/getmasssendmsg?__biz=other", "MzA3NDAyNzU2NQ=="); err == nil {
		t.Fatal("mismatched account identity must be rejected")
	}
}

func TestOfficialAccountHistoryStatusRequiresExactFreshCredentials(t *testing.T) {
	server := &OfficialAccountServer{history_credentials: map[string]nativeOfficialAccountHistoryCredentials{}}
	biz := "MzA3NDAyNzU2NQ=="
	server.rememberNativeOfficialAccountHistoryCredentials(`{"biz":"other","uin":"one","key":"two"}`)
	if server.HasHealthyOfficialAccountHistory(biz) {
		t.Fatal("another account history context must not satisfy readiness")
	}
	server.rememberNativeOfficialAccountHistoryCredentials(`{"biz":"MzA3NDAyNzU2NQ==","uin":"MTE1MzA0NjI2NQ==","key":"secret","pass_ticket":"ticket"}`)
	if !server.HasHealthyOfficialAccountHistory(biz) {
		t.Fatal("exact account history credentials were not detected")
	}
	credentials := server.history_credentials[biz]
	credentials.CapturedAt = time.Now().Add(-nativeOfficialAccountHistoryCredentialsTTL - time.Second)
	server.history_credentials[biz] = credentials
	if server.HasHealthyOfficialAccountHistory(biz) {
		t.Fatal("stale account history credentials must not be ready")
	}
}

func TestDecodeOfficialAccountHistoryResponse(t *testing.T) {
	got, err := decodeOfficialAccountHistoryResponse([]byte(`{"errCode":0,"data":{"can_msg_continue":1,"next_offset":10}}`))
	if err != nil || string(got) != `{"can_msg_continue":1,"next_offset":10}` {
		t.Fatalf("unexpected decoded response %s, %v", got, err)
	}
	if _, err := decodeOfficialAccountHistoryResponse([]byte(`{"errCode":1001,"errMsg":"expired"}`)); err == nil || !strings.Contains(err.Error(), "expired") {
		t.Fatalf("expected bridge error, got %v", err)
	}
}
