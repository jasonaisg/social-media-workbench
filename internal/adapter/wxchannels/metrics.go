package wxchannelsadapter

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
	"wx_channel/internal/adapter"
	result "wx_channel/internal/apiresult"
	"wx_channel/internal/database/model"
	"wx_channel/internal/services"
	"wx_channel/pkg/scraper/wxchannels"
)

type interactionMetrics struct {
	Counts         map[string]int64 `json:"counts"`
	FavInfo        map[string]int64 `json:"fav_info,omitempty"`
	FetchedAt      int64            `json:"fetched_at,omitempty"`
	FieldFetchedAt map[string]int64 `json:"field_fetched_at,omitempty"`
	MissingLatest  []string         `json:"missing_latest,omitempty"`
	AttemptedAt    int64            `json:"attempted_at,omitempty"`
	Source         string           `json:"source,omitempty"`
	Status         string           `json:"status"`
	Error          string           `json:"error,omitempty"`
}

var metricFields = []string{"likeCount", "favCount", "forwardCount", "commentCount"}

func extractMetrics(raw json.RawMessage, id string) (*interactionMetrics, error) {
	var response struct {
		ErrCode int    `json:"errCode"`
		ErrMsg  string `json:"errMsg"`
		Data    struct {
			Object map[string]json.RawMessage `json:"object"`
		} `json:"data"`
	}
	if err := json.Unmarshal(raw, &response); err != nil {
		return nil, err
	}
	if response.ErrCode != 0 {
		return nil, fmt.Errorf("微信详情请求失败：%s", response.ErrMsg)
	}
	object := response.Data.Object
	var gotID string
	if err := json.Unmarshal(object["id"], &gotID); err != nil || gotID != id {
		return nil, fmt.Errorf("作品身份不匹配")
	}
	m := &interactionMetrics{Counts: map[string]int64{}, FavInfo: map[string]int64{}, FetchedAt: time.Now().Unix(), Source: "feed/profile", Status: "ok"}
	for _, key := range metricFields {
		var n int64
		if v := object[key]; len(v) > 0 && string(v) != "null" && json.Unmarshal(v, &n) == nil && n >= 0 {
			m.Counts[key] = n
		}
	}
	if len(m.Counts) == 0 {
		return nil, fmt.Errorf("详情没有返回互动计数")
	}
	for _, key := range metricFields[:3] {
		if _, ok := m.Counts[key]; !ok {
			m.Status = "partial"
			m.MissingLatest = append(m.MissingLatest, key)
		}
	}
	var ext struct {
		FavInfo map[string]json.RawMessage `json:"favInfo"`
	}
	_ = json.Unmarshal(object["objectExtend"], &ext)
	for _, key := range []string{"fingerlikeFavCount", "starFavCount"} {
		var n int64
		if v := ext.FavInfo[key]; len(v) > 0 && string(v) != "null" && json.Unmarshal(v, &n) == nil && n >= 0 {
			m.FavInfo[key] = n
		}
	}
	return m, nil
}

func mergeMetrics(metadata string, fresh *interactionMetrics) (string, error) {
	fields := map[string]json.RawMessage{}
	if metadata != "" {
		if err := json.Unmarshal([]byte(metadata), &fields); err != nil {
			return "", err
		}
	}
	if fields == nil {
		fields = map[string]json.RawMessage{}
	}
	old := interactionMetrics{}
	_ = json.Unmarshal(fields["wxchannels_metrics"], &old)
	next := *fresh
	if fresh.Status == "failed" {
		next = old
		next.Status = "failed"
		next.AttemptedAt = fresh.AttemptedAt
		next.Error = fresh.Error
	} else {
		next.Counts = map[string]int64{}
		next.FieldFetchedAt = map[string]int64{}
		for k, v := range old.Counts {
			next.Counts[k] = v
		}
		for k, v := range old.FieldFetchedAt {
			next.FieldFetchedAt[k] = v
		}
		for k, v := range fresh.Counts {
			next.Counts[k] = v
			next.FieldFetchedAt[k] = fresh.FetchedAt
		}
	}
	encoded, err := json.Marshal(next)
	if err != nil {
		return "", err
	}
	fields["wxchannels_metrics"] = encoded
	data, err := json.Marshal(fields)
	return string(data), err
}

func (r *WebsocketRoutes) saveMetrics(id string, m *interactionMetrics) error {
	if r.db == nil {
		return fmt.Errorf("数据库不可用")
	}
	return r.db.Transaction(func(tx *gorm.DB) error {
		var content model.Content
		err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("id = ?", BuildContentID(id)).First(&content).Error
		if err != nil {
			return err
		}
		metadata, err := mergeMetrics(content.Metadata, m)
		if err != nil {
			return err
		}
		if err := tx.Model(&content).UpdateColumn("metadata", metadata).Error; err != nil {
			return err
		}
		var tasks []model.DownloadTask
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("content_id = ?", content.Id).Find(&tasks).Error; err != nil {
			return err
		}
		for _, task := range tasks {
			v, err := mergeMetrics(task.MetadataJSON, m)
			if err != nil {
				return err
			}
			if err := tx.Model(&task).UpdateColumn("metadata_json", v).Error; err != nil {
				return err
			}
		}
		return nil
	})
}

func (r *WebsocketRoutes) HandleMetrics(ctx *gin.Context) {
	if r.db == nil {
		result.Err(ctx, 503, "数据库不可用")
		return
	}
	ids := strings.Split(ctx.Query("ids"), ",")
	if len(ids) > 100 {
		result.Err(ctx, 400, "每次最多100条")
		return
	}
	keys := make([]string, 0, len(ids))
	for _, id := range ids {
		if id != "" {
			keys = append(keys, BuildContentID(id))
		}
	}
	var records []model.Content
	if err := r.db.Select("external_id", "metadata").Where("id IN ?", keys).Find(&records).Error; err != nil {
		result.Err(ctx, 500, err.Error())
		return
	}
	downloadedIDs, err := services.DownloadedContentIDs(r.db)
	if err != nil {
		result.Err(ctx, 500, err.Error())
		return
	}
	downloaded := map[string]bool{}
	for _, id := range downloadedIDs {
		downloaded[id] = true
	}
	values := map[string]json.RawMessage{}
	for _, id := range ids {
		if id != "" {
			values[id], _ = json.Marshal(map[string]bool{"local_downloaded": downloaded[BuildContentID(id)]})
		}
	}
	for _, record := range records {
		var m map[string]json.RawMessage
		_ = json.Unmarshal([]byte(record.Metadata), &m)
		value := map[string]interface{}{}
		_ = json.Unmarshal(m["wxchannels_metrics"], &value)
		if value == nil {
			value = map[string]interface{}{}
		}
		value["local_downloaded"] = downloaded[BuildContentID(record.ExternalId)]
		values[record.ExternalId], _ = json.Marshal(value)
	}
	result.Ok(ctx, values)
}

func (r *WebsocketRoutes) HandleRefreshMetrics(ctx *gin.Context) {
	var body struct {
		ID      string `json:"id"`
		NonceID string `json:"nonce_id"`
	}
	if ctx.ShouldBindJSON(&body) != nil || body.ID == "" {
		result.Err(ctx, 400, "缺少作品 ID")
		return
	}
	// Serialize manual refreshes; never send a burst to the WeChat bridge.
	r.metricsMu.Lock()
	defer r.metricsMu.Unlock()
	if delay := time.Until(r.metricsLast.Add(5 * time.Second)); delay > 0 {
		select {
		case <-time.After(delay):
		case <-ctx.Request.Context().Done():
			return
		}
	}
	r.metricsLast = time.Now()
	raw, err := r.client.RequestFrontend("key:channels:feed_profile", wxchannels.ChannelsFeedProfileBody{ObjectId: body.ID, NonceId: body.NonceID}, 10*time.Second)
	var m *interactionMetrics
	if err == nil {
		m, err = extractMetrics(raw, body.ID)
	}
	if err != nil {
		failed := &interactionMetrics{Status: "failed", AttemptedAt: time.Now().Unix(), Error: err.Error()}
		_ = r.saveMetrics(body.ID, failed)
		result.Err(ctx, 400, err.Error())
		return
	}
	// Un-downloaded search results can still show freshly fetched metrics in memory.
	if err := r.saveMetrics(body.ID, m); err != nil && err != gorm.ErrRecordNotFound {
		result.Err(ctx, 500, "互动数据已获取，但保存失败："+err.Error())
		return
	}
	result.Ok(ctx, m)
}

// Carry the observed counters across the search -> task -> archive boundary.
func (a *ChannelsAdapter) BuildDownloadTask(raw json.RawMessage, config json.RawMessage) (*adapter.DownloadTaskResult, error) {
	info, err := a.buildDownloadTask(raw, config)
	if err != nil || info == nil || info.Content == nil || info.Task == nil {
		return info, err
	}
	var payload struct {
		Metrics *interactionMetrics `json:"wxchannels_metrics"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return nil, err
	}
	m := payload.Metrics
	if m == nil {
		envelope, _ := json.Marshal(map[string]any{"data": map[string]any{"object": raw}})
		m, _ = extractMetrics(envelope, info.Content.ExternalId)
	}
	if m == nil || len(m.Counts) == 0 {
		return info, nil
	}
	// Restrict the snapshot to genuine nonnegative counters, preserving absent values.
	clean := map[string]int64{}
	for _, key := range metricFields {
		if n, ok := m.Counts[key]; ok && n >= 0 {
			clean[key] = n
		}
	}
	if len(clean) == 0 {
		return info, nil
	}
	m.Counts = clean
	m.Status = "ok"
	for _, key := range metricFields[:3] {
		if _, ok := clean[key]; !ok {
			m.Status = "partial"
		}
	}
	info.Content.Metadata, err = mergeMetrics(info.Content.Metadata, m)
	if err != nil {
		return nil, err
	}
	info.Task.MetadataJSON, err = mergeMetrics(info.Task.MetadataJSON, m)
	if err != nil {
		return nil, err
	}
	return info, nil
}
