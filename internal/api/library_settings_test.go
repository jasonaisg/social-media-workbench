package api

import (
	"bytes"
	"encoding/json"
	"github.com/gin-gonic/gin"
	"github.com/spf13/viper"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"wx_channel/internal/config"
)

func TestLibrarySettingsSavesWithoutRestartAndRejectsOldMaster(t *testing.T) {
	viper.Reset()
	defer viper.Reset()
	root := t.TempDir()
	current := filepath.Join(root, "current")
	os.MkdirAll(current, 0700)
	cfg := &config.Config{FullPath: filepath.Join(current, "config.yaml"), WorkDir: current}
	client := &APIClient{cfg: &APIConfig{Original: cfg, WorkDir: current}}
	request := func(target string) map[string]any {
		body, _ := json.Marshal(map[string]string{"master": target})
		w := httptest.NewRecorder()
		ctx, _ := gin.CreateTestContext(w)
		ctx.Request = httptest.NewRequest("POST", "/api/library/master", bytes.NewReader(body))
		ctx.Request.Header.Set("Content-Type", "application/json")
		client.handleLibrarySet(ctx)
		var result map[string]any
		if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
			t.Fatal(err)
		}
		return result
	}
	target := filepath.Join(root, "new")
	result := request(target)
	if result["code"] != float64(0) {
		t.Fatal(result)
	}
	if result["data"].(map[string]any)["restart_scheduled"] != false {
		t.Fatal("must use launcher for migration")
	}
	if viper.GetString("workdir") != target {
		t.Fatal("not saved")
	}
	if _, err := os.Stat(target); !os.IsNotExist(err) {
		t.Fatal("must not migrate live data")
	}
	old := filepath.Join(root, "old")
	os.MkdirAll(old, 0700)
	os.WriteFile(filepath.Join(old, "master.json"), []byte(`{"schema_version":3}`), 0600)
	if request(old)["code"] == float64(0) {
		t.Fatal("old Master accepted")
	}
	if request(filepath.Join(current, "inside"))["code"] == float64(0) {
		t.Fatal("nested Master accepted")
	}
}
