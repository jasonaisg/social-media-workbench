package wxmpadapter

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"gorm.io/gorm"

	"wx_channel/internal/database/model"
)

func TestArticleExternalIDFromURL(t *testing.T) {
	got := ArticleExternalIDFromURL("https://mp.weixin.qq.com/s?__biz=MzA3NDAyNzU2NQ%3D%3D&mid=2454851772&idx=1&sn=abc")
	if got != "MzA3NDAyNzU2NQ==_2454851772_1" {
		t.Fatalf("unexpected external id: %q", got)
	}
	for _, invalid := range []string{
		"https://example.com/s?__biz=MzA3NDAyNzU2NQ==&mid=1&idx=1",
		"https://mp.weixin.qq.com/s?__biz=bad&mid=1&idx=1",
		"https://mp.weixin.qq.com/s?__biz=MzA3NDAyNzU2NQ==&mid=1",
	} {
		if ArticleExternalIDFromURL(invalid) != "" {
			t.Fatalf("invalid URL accepted: %s", invalid)
		}
	}
}

func TestArticleDownloadStatusUsesCompleteLocalArchive(t *testing.T) {
	gin.SetMode(gin.TestMode)
	root := t.TempDir()
	db, err := gorm.Open(sqlite.Open(filepath.Join(root, "status.db")), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&model.DownloadResource{}, &model.ContentRelation{}); err != nil {
		t.Fatal(err)
	}
	downloaded_url := "https://mp.weixin.qq.com/s?__biz=MzA3NDAyNzU2NQ%3D%3D&mid=2454851772&idx=1&sn=abc"
	missing_url := "https://mp.weixin.qq.com/s?__biz=MzA3NDAyNzU2NQ%3D%3D&mid=2454851773&idx=1&sn=def"
	content_id := BuildContentID("MzA3NDAyNzU2NQ==_2454851772_1")
	if err := os.WriteFile(filepath.Join(root, "article.html"), []byte("complete"), 0600); err != nil {
		t.Fatal(err)
	}
	resource := model.DownloadResource{ContentId: &content_id, DownloadDir: root, Name: "article.html", Kind: "text/html", Size: 999, Status: 2}
	if err := db.Create(&resource).Error; err != nil {
		t.Fatal(err)
	}

	routes := &Routes{db: db}
	engine := gin.New()
	engine.POST("/status", routes.handle_article_download_status)
	body, _ := json.Marshal(map[string]any{"urls": []string{downloaded_url, missing_url, "https://example.com/not-wechat"}})
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/status", bytes.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	engine.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	var envelope struct {
		Data struct {
			Statuses map[string]string `json:"statuses"`
		} `json:"data"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &envelope); err != nil {
		t.Fatal(err)
	}
	if envelope.Data.Statuses[downloaded_url] != "downloaded" || envelope.Data.Statuses[missing_url] != "not_downloaded" || envelope.Data.Statuses["https://example.com/not-wechat"] != "unknown" {
		t.Fatalf("unexpected statuses: %#v", envelope.Data.Statuses)
	}
}
