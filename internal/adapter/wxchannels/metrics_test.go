package wxchannelsadapter

import (
	"encoding/json"
	"testing"
)

func TestMetricsMissingInvalidAndZero(t *testing.T) {
	raw := json.RawMessage(`{"errCode":0,"data":{"object":{"id":"18446744073709551610","likeCount":0,"favCount":null,"forwardCount":12,"commentCount":true}}}`)
	m, err := extractMetrics(raw, "18446744073709551610")
	if err != nil {
		t.Fatal(err)
	}
	if m.Counts["likeCount"] != 0 || m.Counts["forwardCount"] != 12 || len(m.Counts) != 2 || m.Status != "partial" {
		t.Fatalf("unexpected: %+v", m)
	}
	if _, err := extractMetrics(raw, "wrong"); err == nil {
		t.Fatal("identity mismatch accepted")
	}
	if _, err := extractMetrics(json.RawMessage(`{"errCode":1,"errMsg":"expired"}`), "id"); err == nil {
		t.Fatal("error accepted")
	}
}
func TestMetricsPreserveMetadataAndOldCounts(t *testing.T) {
	initial := `{"key":"secret-retained","other":{"a":1},"wxchannels_metrics":{"counts":{"favCount":9,"likeCount":3},"fetched_at":10,"field_fetched_at":{"favCount":10,"likeCount":10}}}`
	fresh := &interactionMetrics{Counts: map[string]int64{"likeCount": 0}, FetchedAt: 20, Status: "partial"}
	out, err := mergeMetrics(initial, fresh)
	if err != nil {
		t.Fatal(err)
	}
	var decoded struct {
		Key     string             `json:"key"`
		Other   map[string]int     `json:"other"`
		Metrics interactionMetrics `json:"wxchannels_metrics"`
	}
	_ = json.Unmarshal([]byte(out), &decoded)
	if decoded.Key != "secret-retained" || decoded.Other["a"] != 1 || decoded.Metrics.Counts["favCount"] != 9 || decoded.Metrics.Counts["likeCount"] != 0 || decoded.Metrics.FieldFetchedAt["favCount"] != 10 {
		t.Fatalf("lost metadata: %s", out)
	}
	failed, err := mergeMetrics(out, &interactionMetrics{Status: "failed", AttemptedAt: 30, Error: "offline"})
	if err != nil {
		t.Fatal(err)
	}
	_ = json.Unmarshal([]byte(failed), &decoded)
	if decoded.Metrics.Counts["favCount"] != 9 || decoded.Metrics.FetchedAt != 20 || decoded.Metrics.Status != "failed" {
		t.Fatalf("failure overwrote values: %s", failed)
	}
	if _, err := mergeMetrics("malformed", fresh); err == nil {
		t.Fatal("invalid existing metadata overwritten")
	}
}

func TestDownloadCarriesInteractionSnapshot(t *testing.T) {
	a := &ChannelsAdapter{}
	raw := json.RawMessage(`{"id":"123","contact":{"username":"author","nickname":"Author"},"objectDesc":{"mediaType":4,"description":"Video","media":[{"url":"https://example.com/video.mp4","decodeKey":"12345","fileSize":100,"videoPlayLen":5}]},"wxchannels_metrics":{"counts":{"favCount":0,"forwardCount":12},"fetched_at":123,"status":"partial"}}`)
	info, err := a.BuildDownloadTask(raw, json.RawMessage(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	for _, metadata := range []string{info.Task.MetadataJSON, info.Content.Metadata} {
		var saved struct {
			Metrics interactionMetrics `json:"wxchannels_metrics"`
		}
		if err := json.Unmarshal([]byte(metadata), &saved); err != nil {
			t.Fatal(err)
		}
		if v, ok := saved.Metrics.Counts["favCount"]; !ok || v != 0 {
			t.Fatalf("zero missing: %s", metadata)
		}
		if saved.Metrics.Counts["forwardCount"] != 12 || saved.Metrics.FetchedAt != 123 {
			t.Fatalf("snapshot lost: %s", metadata)
		}
		if _, ok := saved.Metrics.Counts["likeCount"]; ok {
			t.Fatal("invented missing count")
		}
	}
	if parse_key_from_content(info.Content) != "12345" {
		t.Fatal("decrypt key lost")
	}
}
