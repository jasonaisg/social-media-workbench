package cache

import (
	"path/filepath"
	"testing"
)

func TestProviderRegistryUsesRuntimeCache(t *testing.T) {
	work_dir := t.TempDir()
	registry, err := NewProviderRegistry(work_dir)
	if err != nil {
		t.Fatal(err)
	}
	provider, err := registry.Namespace("wxmp")
	if err != nil {
		t.Fatal(err)
	}
	path, err := provider.Path("html/example.html")
	if err != nil {
		t.Fatal(err)
	}
	want := filepath.Join(work_dir, "runtime", "cache", "wxmp", "html", "example.html")
	if path != want {
		t.Fatalf("cache path = %q, want %q", path, want)
	}
}
