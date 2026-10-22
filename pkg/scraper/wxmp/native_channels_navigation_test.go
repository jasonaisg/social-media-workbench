package wxmp

import "testing"

func TestNormalizeNativeChannelsProfileUsername(t *testing.T) {
	got, err := normalizeNativeChannelsProfileUsername(" v2_060000231003b20faec8c6e6891dc1d3ce00e534b077d84edd69cd912516e84554698c16fd80@finder ")
	if err != nil || got == "" {
		t.Fatalf("expected valid Finder username, got %q, %v", got, err)
	}
	for _, value := range []string{"", "https://example.com", "../profile@finder", "name@finder.invalid"} {
		if _, err := normalizeNativeChannelsProfileUsername(value); err == nil {
			t.Fatalf("expected invalid Finder username to fail: %q", value)
		}
	}
}
