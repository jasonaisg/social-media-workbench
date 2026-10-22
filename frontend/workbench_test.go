//go:build embed_inject || embed_frontend_inject

package frontend

import (
	"strings"
	"testing"
)

func TestWorkbenchEmbeddedAssets(t *testing.T) {
	html, err := Assets().ReadRoot("index.html")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(html), "src/index.js") {
		t.Fatal("missing native application entry")
	}
	for _, name := range []string{"channels-workbench.mjs", "channels-workbench.css", "mp-article-search.mjs"} {
		data, err := Assets().ReadPublic(name)
		if err != nil || len(data) == 0 {
			t.Fatalf("missing embedded %s: %v", name, err)
		}
	}
	if got := StaticAssetContentType("channels-workbench.mjs"); !strings.HasPrefix(got, "application/javascript") {
		t.Fatalf("module scripts require JavaScript MIME type, got %s", got)
	}
}
