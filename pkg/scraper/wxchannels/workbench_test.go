package wxchannels

import (
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/ltaoo/echo"
)

func TestWorkbenchInjectionKeepsBridgeWithoutDownloadUI(t *testing.T) {
	for _, page := range []string{"profile", "feed", "home", "live"} {
		t.Run(page, func(t *testing.T) {
			ctx := &echo.Context{
				Req: httptest.NewRequest("GET", "https://channels.weixin.qq.com/web/pages/"+page, nil),
				Res: &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{"text/html"}}, Body: io.NopCloser(strings.NewReader("<html><head></head><body><div class='opr-area'>微信原有内容</div></body></html>"))},
			}
			plugins := NewInterceptorPlugins(InterceptorConfig{Mode: "release", Version: "workbench"}, nil)
			plugins[0].OnResponse(ctx)
			body, err := ctx.GetResponseBody()
			if err != nil {
				t.Fatal(err)
			}
			for _, want := range []string{"ChannelsWebsocketClient", "channels:APILoaded", "微信原有内容", "key:channels:bridge_status"} {
				if !strings.Contains(body, want) {
					t.Errorf("missing bridge or original content: %s", want)
				}
			}
			for _, forbidden := range []string{"__wx_insert_batch_download_btn", "function DownloaderPanelViewModel", "channels.profile.js", "channels.home.js", "channels.feed.js", "channels.live.js"} {
				if strings.Contains(body, forbidden) {
					t.Errorf("unexpected download UI: %s", forbidden)
				}
			}
			if page == "profile" && os.Getenv("SPH_TEST_HTML") != "" {
				if err := os.WriteFile(os.Getenv("SPH_TEST_HTML"), []byte(body), 0600); err != nil {
					t.Fatal(err)
				}
			}
		})
	}
}
