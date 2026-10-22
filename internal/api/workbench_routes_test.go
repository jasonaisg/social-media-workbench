//go:build embed_inject || embed_frontend_inject

package api

import (
	"io/fs"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"wx_channel/frontend"

	"github.com/gin-gonic/gin"
	"wx_channel/internal/config"
)

func TestWorkbenchThroughCompleteHTTPHandler(t *testing.T) {
	gin.SetMode(gin.TestMode)
	client := &APIClient{
		cfg:         &APIConfig{Mode: "release", Version: "workbench-test", Original: &config.Config{}, Protocol: "http", Hostname: "127.0.0.1", Port: 2022},
		engine:      gin.New(),
		file_helper: &FileHelperHandler{},
	}
	client.SetupRoutes()
	cases := []struct{ path, content, mime string }{
		{"/", "<title>视频号工作台</title>", "text/html"},
		{"/channels", "<title>视频号工作台</title>", "text/html"},
		{"/src/pages/channels.js", "DownloadV2Page", "text/javascript"},
		{"/src/store.js", "root", "text/javascript"},
		{"/download", "src/index.js", "text/html"},
		{"/__assets/public/channels-workbench.mjs", "export function mount", "application/javascript"},
		{"/__assets/public/channels-workbench.css", ".workspace", "text/css"},
	}
	for _, item := range cases {
		t.Run(item.path, func(t *testing.T) {
			response := httptest.NewRecorder()
			client.ServeHTTP(response, httptest.NewRequest("GET", item.path, nil))
			if response.Code != 200 {
				t.Fatalf("status %d: %s", response.Code, response.Body.String())
			}
			if !strings.Contains(response.Body.String(), item.content) {
				t.Errorf("%s did not return expected page/asset %q", item.path, item.content)
			}
			if !strings.HasPrefix(response.Header().Get("Content-Type"), item.mime) {
				t.Errorf("unexpected MIME: %s", response.Header().Get("Content-Type"))
			}
		})
	}
	// Export actual HTTP responses for offline browser QA; no Host is started.
	if directory := os.Getenv("SPH_HTTP_FIXTURES"); directory != "" {
		paths := []string{"/", "/channels", "/download", "/__assets/public/channels-workbench.mjs", "/__assets/public/channels-workbench.css"}
		err := fs.WalkDir(frontend.FS, ".", func(name string, entry fs.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if !entry.IsDir() {
				paths = append(paths, "/"+name)
			}
			return nil
		})
		if err != nil {
			t.Fatal(err)
		}
		for _, path := range paths {
			response := httptest.NewRecorder()
			client.ServeHTTP(response, httptest.NewRequest("GET", path, nil))
			if response.Code == 301 || response.Code == 302 {
				continue
			}
			if response.Code != 200 {
				t.Fatalf("fixture %s returned %d", path, response.Code)
			}
			if path == "/" {
				path = "/__root__.html"
			}
			target := filepath.Join(directory, strings.TrimPrefix(path, "/"))
			if err := os.MkdirAll(filepath.Dir(target), 0700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(target, response.Body.Bytes(), 0600); err != nil {
				t.Fatal(err)
			}
		}
	}

}
