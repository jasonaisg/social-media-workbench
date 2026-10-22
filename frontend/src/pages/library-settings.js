export function LibrarySettings() {
  return View({ class: 'settings-dialog__panel-inner', onMounted(event) {
    const root = event.target.get$elm();
    root.innerHTML = `<h2>资料库</h2><p>所有下载按平台、账号和内容类型归档，使用稳定 ID 文件名；标题保存在数据库中。</p><p id="library-current" style="overflow-wrap:anywhere"></p><form><label for="master-path">Master 文件夹</label><input id="master-path" required autocomplete="off" style="display:block;width:100%;box-sizing:border-box;padding:10px;margin:12px 0;color:inherit;background:transparent;border:1px solid currentColor;border-radius:6px"><p>填写完整路径。下次手动启动时，空目录会迁入当前整库；已有资料库会直接切换读取，不合并两库。原库和迁移备份会保留。</p><button class="dm-button" type="submit">保存资料库位置</button></form><p id="library-feedback" role="status"></p>`;
    const message = root.querySelector('#library-feedback');
    const input = root.querySelector('input');
    const button = root.querySelector('button');
    const request = async (method, body) => {
      const response = await fetch('/api/library/master', {method, headers:{'Content-Type':'application/json'}, ...(body ? {body:JSON.stringify(body)} : {})});
      const data = await response.json();
      if (!response.ok || data.code !== 0) throw new Error(data.msg || data.message || '读取资料库失败');
      return data.data;
    };
    request('GET').then(data => {
      input.value = data.pending_master || data.master;
      root.querySelector('#library-current').textContent = '当前资料库：' + data.master;
    }).catch(error => { message.textContent = error.message; });
    root.querySelector('form').onsubmit = async event => {
      event.preventDefault(); button.disabled = true;
      try { const data = await request('POST', {master: input.value.trim()}); message.textContent = data.message; }
      catch (error) { message.textContent = error.message; }
      finally { button.disabled = false; }
    };
  } });
}
