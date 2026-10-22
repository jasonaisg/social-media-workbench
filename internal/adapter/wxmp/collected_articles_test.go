package wxmpadapter

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/gin-gonic/gin"
)

func TestCollectedArticlesPersistAndRejectNonWeChatURL(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r := &Routes{collectedArticlePath: filepath.Join(t.TempDir(), "runtime", "collected.json")}
	engine := gin.New()
	engine.POST("/collected", r.handle_save_collected_articles)
	engine.GET("/collected", r.handle_list_collected_articles)
	article := `{"keyword":"AI","articles":[{"title":"Muse，一夜爆红","author":"财联社","url":"https://mp.weixin.qq.com/s?__biz=abc&mid=123&idx=1&sn=def"}]}`
	request := func(method, target, body string) *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		req := httptest.NewRequest(method, target, bytes.NewBufferString(body))
		if body != "" {
			req.Header.Set("Content-Type", "application/json")
		}
		engine.ServeHTTP(w, req)
		return w
	}
	if w := request(http.MethodPost, "/collected", article); w.Code != http.StatusOK {
		t.Fatalf("save: %d %s", w.Code, w.Body.String())
	}
	if w := request(http.MethodPost, "/collected", article); w.Code != http.StatusOK {
		t.Fatalf("deduplicate: %d %s", w.Code, w.Body.String())
	}
	w := request(http.MethodGet, "/collected?keyword=AI", "")
	var envelope struct {
		Data struct {
			Articles []CollectedArticle `json:"articles"`
		} `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &envelope); err != nil || len(envelope.Data.Articles) != 1 {
		t.Fatalf("read persisted result: %v %s", err, w.Body.String())
	}
	if validCollectedArticleURL("https://example.com/s?__biz=abc") || validCollectedArticleURL("http://mp.weixin.qq.com/s?__biz=abc") {
		t.Fatal("non-WeChat or insecure URL accepted")
	}
}
