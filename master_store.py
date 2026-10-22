"""Offline library migration and launch selection. Run only with Conda conda_video.

SQLite remains the authority. master.json records the layout/root; moving a library
rebases runtime absolute paths before the Host opens its database. Transactional
scratch data lives below runtime/tmp and is removed after success; this module does
not keep rollback copies or fetch media.
"""
from contextlib import contextmanager, closing
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import socket
import sqlite3
import tempfile
import unicodedata
import uuid
import yaml

VERSION = 1

@contextmanager
def database(path):
    # sqlite3.Connection.__exit__ commits but does not close the connection.
    # Close explicitly before relocating any DB/WAL files.
    with closing(sqlite3.connect(path)) as connection:
        with connection:
            yield connection

def stable_id(value):
    value = str(value or '')
    return value if re.fullmatch(r'[A-Za-z0-9_-]{1,120}', value) else hashlib.sha256(value.encode()).hexdigest()

def account_folder(identity, nickname):
    result = ''
    for ch in (nickname or '').strip():
        if len(result.encode()) + len(ch.encode()) > 60:
            break
        result += '_' if unicodedata.category(ch) == 'Cc' or ch in '/\\:*?"<>|' else ch
    return (result.strip('. ') or 'unknown') + '__' + hashlib.sha256(identity.encode()).hexdigest()[:20]

def digest(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for data in iter(lambda: f.read(4 * 1024 * 1024), b''):
            h.update(data)
    return h.hexdigest()

def atomic_json(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + '.pending')
    with open(tmp, 'w') as f:
        os.chmod(tmp, 0o600)
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)

def read_config(path):
    if not Path(path).exists():
        return {}
    return yaml.safe_load(Path(path).read_text()) or {}

def assert_stopped():
    for port in (19321, 19222, 2022, 2023):
        with socket.socket() as sock:
            if sock.connect_ex(('127.0.0.1', port)) == 0:
                raise RuntimeError('工作台仍在运行，请先在启动终端按 Ctrl+C 停止；未迁移资料。')

def tables(c):
    return {r[0] for r in c.execute("select name from sqlite_master where type='table'")}

def rebase_database(c, old, new):
    if old == new:
        return
    # Persisted configs and endpoint extras can also contain local paths. Replace
    # only the exact old root + separator, never account names or remote URLs.
    old_prefix, new_prefix = str(old) + '/', str(new) + '/'
    for table in tables(c):
        if table.startswith('sqlite_'):
            continue
        quoted = '"' + table.replace('"', '""') + '"'
        for col in c.execute('pragma table_info(' + quoted + ')').fetchall():
            if col[2].upper() not in ('TEXT', 'VARCHAR', 'STRING'):
                continue
            column = '"' + col[1].replace('"', '""') + '"'
            c.execute(f'UPDATE {quoted} SET {column}=replace({column},?,?) WHERE instr({column},?)>0', (old_prefix,new_prefix,old_prefix))

def audit_downloaded_files(master):
    db=master/'runtime/data.db'
    with database(db) as c:
        if 'download_resource' not in tables(c): return
        missing=[]
        query='''select r.id,r.task_id,r.download_dir,r.name,r.size,r.kind,t.platform_id
          from download_resource r join download_task t on t.id=r.task_id
          where r.status=2 and r.deleted_at is null and t.deleted_at is null'''
        for rid,tid,directory,name,size,kind,platform in c.execute(query):
            p=Path(directory)/name
            exists=p.is_file() and p.stat().st_size>0
            changed=exists and size>0 and p.stat().st_size!=size
            rendered_wxmp=(platform=='wxmp' and str(kind or '').lower() in ('html','text/html') and reusable_wxmp_archive(p))
            if not exists or (changed and not rendered_wxmp): missing.append((rid,tid,str(p)))
        if not missing: return []
        for rid,tid,path in missing:
            c.execute('update download_resource set status=3 where id=?',(rid,))
            c.execute('update download_task set status=6,error_message=? where id=?',('本地文件缺失或大小变化；请重新抓取补下',tid))
        return missing

def reusable_wxmp_archive(path):
    try:
        with open(path,'rb') as f: head=f.read(256*1024)
    except OSError:
        return False
    return (b'class="wxmp-article-shell"' in head and
            b'id="js_content"' in head and
            b'rich_media_content' in head)

def remove_empty_ancestors(path, stop):
    path, stop = Path(path), Path(stop)
    while path != stop and path.is_relative_to(stop):
        try:
            path.rmdir()
        except OSError:
            break
        path = path.parent

def migrate_layout(master):
    master = Path(master).resolve()
    master.mkdir(parents=True,exist_ok=True)
    runtime = master/'runtime'
    runtime.mkdir(exist_ok=True)
    lock = open(runtime/'.migration.lock','a+')
    try:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        return _migrate_layout(master)
    finally:
        lock.close()
        legacy_lock = master/'.migration.lock'
        if legacy_lock.exists():
            legacy_lock.unlink()

def _migrate_layout(master):
    marker_path = master/'master.json'
    runtime = master/'runtime'
    config = read_config(master/'config.yaml')
    if marker_path.exists():
        marker = json.loads(marker_path.read_text())
        if marker.get('layout_version') != VERSION:
            raise RuntimeError('目标不是新版工作台资料库，拒绝修改旧 Master。')
        if config.get('db',{}).get('type','sqlite') != 'sqlite':
            raise RuntimeError('Master 模式仅支持 SQLite')
        db = master/'runtime/data.db'
        if not db.exists():
            raise RuntimeError('Master 标记存在但数据库缺失，拒绝创建空库。')
        marker_changed = marker.pop('migration_manifest',None) is not None
        old = Path(marker['root'])
        if old != master:
            with database(db) as c:
                rebase_database(c,old,master)
                if c.execute('pragma integrity_check').fetchone()[0] != 'ok':
                    raise RuntimeError('迁移后数据库完整性检查失败')
            config=json.loads(json.dumps(config).replace(str(old)+'/',str(master)+'/'))
            marker['root'] = str(master)
            marker_changed = True
        if marker_changed:
            atomic_json(marker_path,marker)
        config['workdir'] = str(master)
        config.setdefault('download',{})['dir'] = str(master/'library')
        config.setdefault('db',{})['filepath'] = str(db)
        atomic_json(master/'config.yaml',config)
        return marker
    old_db = master/'data.db'
    if not old_db.exists():
        # An empty new library must be explicitly initialized; do not silently
        # reinterpret a nonempty arbitrary folder as a library.
        allowed = {'runtime','config.yaml','.migration.lock'}
        if any(p.name not in allowed for p in master.iterdir()):
            raise RuntimeError('非空目录没有工作台数据库，拒绝初始化')
        sqlite3.connect(runtime/'data.db').close()
        marker = {'layout_version':VERSION,'library_id':uuid.uuid4().hex,'root':str(master)}
        atomic_json(marker_path,marker)
        config['workdir'] = str(master)
        config.setdefault('download',{})['dir']=str(master/'library')
        config.setdefault('db',{})['filepath']=str(runtime/'data.db')
        atomic_json(master/'config.yaml',config)
        return marker
    # An unfinished migration is explicit, never overwrite an unverified target DB.
    if (runtime/'data.db').exists():
        raise RuntimeError('发现未完成迁移的 runtime/data.db，请先核对并清理未完成迁移')
    scratch_root = runtime/'tmp'
    scratch_root.mkdir(exist_ok=True)
    copied=[]
    missing=[]
    with tempfile.TemporaryDirectory(prefix='layout-',dir=scratch_root) as batch_name:
        batch=Path(batch_name)
        with database(old_db) as source, database(batch/'migrated.db') as migrated:
            source.backup(migrated)
        with database(batch/'migrated.db') as c:
            c.execute('pragma journal_mode=DELETE')
            c.row_factory=sqlite3.Row
            if c.execute('pragma integrity_check').fetchone()[0]!='ok': raise RuntimeError('原数据库完整性检查失败')
            if c.execute('select count(*) from download_task where deleted_at is null and status in (0,1,2,3,4)').fetchone()[0]:
                raise RuntimeError('存在未完成或暂停任务，请先完成或取消后迁移')
            c.execute('create table if not exists library_account(id text primary key,folder text not null)')
            accounts={r['id']:dict(r) for r in c.execute('select id,nickname from account')}
            for identity,a in accounts.items():
                folder=account_folder(identity,a['nickname']);a['folder']=folder
                c.execute('insert or ignore into library_account values(?,?)',(identity,folder))
            resources=c.execute('''select r.*,t.platform_id,t.content_id as parent_content,t.config_json,c.type as content_type,c.external_id
              from download_resource r join download_task t on t.id=r.task_id left join content c on c.id=t.content_id''').fetchall()
            task_dirs={}
            for row in resources:
                r=dict(row)
                owner=c.execute("select account_id from content_account where content_id=? order by case when role='owner' then 0 else 1 end,account_id limit 1",(r['parent_content'],)).fetchone()
                identity=owner[0] if owner else r['platform_id']+':unknown'
                folder=accounts.get(identity,{}).get('folder') or account_folder(identity,'unknown')
                kind=r['content_type'] or 'other'
                ext=Path(r['name']).suffix.lower()
                if not re.fullmatch(r'\.[a-z0-9]{1,8}',ext):
                    ext={'video/mp4':'.mp4','audio/mpeg':'.mp3','image/jpeg':'.jpg','html':'.html'}.get(r['kind'],'')
                category={'video':'videos','article':'articles','album':'albums','image':'albums','audio':'audio'}.get(kind,'other')
                directory=master/'library'/stable_id(r['platform_id'] or 'unknown')/folder/category
                if kind in ('article','album','image'): directory/=stable_id(r['external_id'] or r['parent_content'])
                dest=directory/(stable_id(r['unique_id'])+ext)
                source=Path(r['download_dir'])/r['name']
                if not source.is_absolute(): source=master/source
                if not source.resolve().is_relative_to(master): raise RuntimeError('资源位于 Master 之外，拒绝自动移动：'+str(source))
                if source.is_symlink(): raise RuntimeError('拒绝迁移符号链接资源：'+str(source))
                source=source.resolve()
                task_dirs[r['task_id']]=directory
                if source.is_file():
                    checksum=digest(source)
                    if dest.exists() and digest(dest)!=checksum: raise RuntimeError('归档目标冲突：'+str(dest))
                    staged=None
                    if not dest.exists():
                        staged=batch/'files'/dest.relative_to(master)
                        staged.parent.mkdir(parents=True,exist_ok=True)
                        shutil.copy2(source,staged)
                        if digest(staged)!=checksum: raise RuntimeError('文件复制校验失败：'+str(dest))
                    copied.append((source,dest,staged))
                else:
                    missing.append((r['id'],r['task_id'],str(source)))
                    c.execute('update download_resource set status=3 where id=?',(r['id'],))
                    c.execute('update download_task set status=6,error_message=? where id=?',('本地文件缺失；可重新抓取补下',r['task_id']))
                c.execute('update download_resource set download_dir=?,name=? where id=?',(str(directory),dest.name,r['id']))
            for task_id,directory in task_dirs.items():
                raw=c.execute('select config_json from download_task where id=?',(task_id,)).fetchone()[0]
                cfg=json.loads(raw or '{}');cfg.update(download_dir=str(directory),library_managed=True)
                c.execute('update download_task set config_json=? where id=?',(json.dumps(cfg,ensure_ascii=False),task_id))
            if c.execute('pragma integrity_check').fetchone()[0]!='ok': raise RuntimeError('目标数据库完整性检查失败')
        for source,dest,staged in copied:
            if staged is not None:
                dest.parent.mkdir(parents=True,exist_ok=True)
                os.replace(staged,dest)
            if digest(dest)!=digest(source): raise RuntimeError('归档发布校验失败：'+str(dest))
        # The old DB and source files remain intact until the verified database,
        # media and configuration have all been published.
        os.replace(batch/'migrated.db',runtime/'data.db')
        config['workdir']=str(master)
        config.setdefault('download',{}).update(dir=str(master/'library'),defaultActionWhenExisting='skip')
        config.setdefault('db',{}).update(filepath=str(runtime/'data.db'),type='sqlite')
        atomic_json(master/'config.yaml',config)
        marker={'layout_version':VERSION,'library_id':uuid.uuid4().hex,'root':str(master),
                'migration':{'files':len(copied),'missing':len(missing)}}
        atomic_json(marker_path,marker)
    for source,dest,_ in copied:
        if source.exists() and source!=dest:
            source.unlink()
            remove_empty_ancestors(source.parent,master)
    for suffix in ('','-wal','-shm'):
        p=Path(str(old_db)+suffix)
        if p.exists(): p.unlink()
    remove_empty_ancestors(scratch_root,master)
    return marker

def ensure_credentials(master):
    config=read_config(master/'config.yaml')
    credentials=master/'runtime/credentials'
    credentials.mkdir(parents=True,exist_ok=True,mode=0o700)
    paths=[]
    for key,name in [('file','session.crt'),('key','session.key')]:
        source=Path(config.get('cert',{}).get(key,''))
        if not source.is_file(): raise RuntimeError('个人工作台证书或密钥缺失，未采用公开内置密钥')
        target=credentials/name
        if source.resolve()!=target.resolve():
            if target.exists() and digest(target)!=digest(source): raise RuntimeError('资料库中证书与配置不同，拒绝覆盖')
            if not target.exists(): shutil.copy2(source,target)
            if digest(source)!=digest(target): raise RuntimeError('证书复制校验失败')
        target.chmod(0o600)
        config['cert'][key]=str(target)
        paths.append(target)
    atomic_json(master/'config.yaml',config)
    return paths

def prepare_master(default_root):
    """Launcher locator stores only the active root, not a second content database."""
    default_root=Path(default_root).resolve()
    locator=default_root/'runtime/launcher.json'
    legacy_locator=default_root/'launcher.json'
    if not locator.exists() and legacy_locator.exists():
        locator=legacy_locator
    current=Path(json.loads(locator.read_text())['master']).resolve() if locator.exists() else default_root
    if locator.exists() and not (current/'master.json').is_file():
        raise RuntimeError('已选择的 Master 不存在，拒绝创建空库。请恢复目录或用 --master 指定移动后的资料库。')
    config=read_config(current/'config.yaml')
    target=Path(config.get('workdir') or current).expanduser().resolve()
    if target!=current:
        if target.is_relative_to(current) or current.is_relative_to(target): raise RuntimeError('新旧资料库不能互相包含')
        if (target/'master.json').exists():
            marker=json.loads((target/'master.json').read_text())
            if marker.get('layout_version')!=VERSION: raise RuntimeError('不能切换到旧工作台 Master')
        else:
            if target.exists() and any(target.iterdir()): raise RuntimeError('目标非空，拒绝覆盖')
            # Copy into staging; publish only after a byte-for-byte verification.
            staging=target.with_name(target.name+'.migrating-'+uuid.uuid4().hex[:8])
            shutil.copytree(current,staging,symlinks=True)
            for p in current.rglob('*'):
                if p.is_symlink(): raise RuntimeError('Master 中存在符号链接，需先核对后迁移')
                if p.is_file() and digest(p)!=digest(staging/p.relative_to(current)): raise RuntimeError('Master 复制校验失败')
            if target.exists(): target.rmdir()
            os.replace(staging,target)
    marker=migrate_layout(target)
    audit_downloaded_files(target)
    runtime_locator=default_root/'runtime/launcher.json'
    atomic_json(runtime_locator,{'master':str(target),'library_id':marker['library_id']})
    if legacy_locator.exists():
        legacy_locator.unlink()
    return target,target/'config.yaml'

if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--master',required=True)
    args=parser.parse_args()
    assert_stopped()
    print(json.dumps(migrate_layout(args.master),ensure_ascii=False,indent=2))
