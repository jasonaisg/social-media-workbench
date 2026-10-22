package api

import (
	"encoding/json"
	"github.com/gin-gonic/gin"
	"os"
	"path/filepath"
	"strings"
	result "wx_channel/internal/apiresult"
)

func (c *APIClient) handleLibraryGet(ctx *gin.Context) {
	result.Ok(ctx, gin.H{"master": c.cfg.WorkDir, "pending_master": c.cfg.Original.GetRaw("workdir"), "layout": "平台 / 账号 / 内容类型 / 稳定 ID", "database": c.cfg.DBPath})
}
func (c *APIClient) handleLibrarySet(ctx *gin.Context) {
	var body struct {
		Master string `json:"master"`
	}
	if err := ctx.ShouldBindJSON(&body); err != nil {
		result.Err(ctx, 400, "无效的资料库路径")
		return
	}
	target := filepath.Clean(strings.TrimSpace(body.Master))
	current := filepath.Clean(c.cfg.WorkDir)
	if !filepath.IsAbs(target) || target == string(filepath.Separator) {
		result.Err(ctx, 400, "请填写完整的 Master 文件夹绝对路径")
		return
	}
	if target != current && (strings.HasPrefix(target, current+string(filepath.Separator)) || strings.HasPrefix(current, target+string(filepath.Separator))) {
		result.Err(ctx, 400, "新旧资料库不能互相包含")
		return
	}
	if entries, err := os.ReadDir(target); err == nil && len(entries) > 0 && target != current {
		raw, err := os.ReadFile(filepath.Join(target, "master.json"))
		var marker struct {
			Version int `json:"layout_version"`
		}
		if err != nil || json.Unmarshal(raw, &marker) != nil || marker.Version != 1 {
			result.Err(ctx, 400, "目标文件夹非空且不是新版资料库；旧 Master 需另行迁移，不能直接覆盖")
			return
		}
	} else if err != nil && !os.IsNotExist(err) {
		result.Err(ctx, 400, "无法读取目标文件夹")
		return
	}
	if err := c.cfg.Original.UpdateAndSave(map[string]interface{}{"workdir": target}); err != nil {
		result.Err(ctx, 500, err.Error())
		return
	}
	result.Ok(ctx, gin.H{"master": current, "pending_master": target, "restart_scheduled": false, "message": "已保存。请退出工作台，再运行启动器：空目录将迁入当前整库；已有资料库将直接切换读取，不合并两库。"})
}
