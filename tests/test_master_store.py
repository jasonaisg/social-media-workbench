import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
import sys
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import master_store as store

class MasterTests(unittest.TestCase):
    def fixture(self,root,missing=False):
        (root/'downloads').mkdir()
        if not missing:(root/'downloads/long title.mp4').write_bytes(b'original video')
        store.atomic_json(root/'config.yaml',{'workdir':str(root)})
        with sqlite3.connect(root/'data.db') as c:
            c.executescript('''create table content(id text,platform_id text,type text,external_id text,title text);
            create table account(id text,nickname text);
            create table content_account(content_id text,account_id text,role text);
            create table download_task(id integer,platform_id text,content_id text,config_json text,status integer,error_message text,deleted_at integer);
            create table download_resource(id integer,task_id integer,download_dir text,name text,kind text,unique_id text,status integer,size integer default 0,deleted_at integer);
            insert into content values('wxchannels:123','wxchannels','video','123','long title');
            insert into account values('wxchannels:a','昵称');
            insert into content_account values('wxchannels:123','wxchannels:a','owner');
            insert into download_task values(1,'wxchannels','wxchannels:123','{}',5,'',null);''')
            c.execute('insert into download_resource(id,task_id,download_dir,name,kind,unique_id,status) values(1,1,?,?,?,?,2)',(str(root/'downloads'),'long title.mp4','video/mp4','123_720p'))
    def test_layout_migration_identity_and_idempotence_without_backups(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);self.fixture(root)
            marker=store.migrate_layout(root)
            with sqlite3.connect(root/'runtime/data.db') as c:
                directory,name=c.execute('select download_dir,name from download_resource').fetchone()
                self.assertEqual(name,'123_720p.mp4')
                self.assertEqual((Path(directory)/name).read_bytes(),b'original video')
                self.assertEqual(c.execute('select title from content').fetchone()[0],'long title')
            self.assertEqual(marker['migration'],{'files':1,'missing':0})
            self.assertFalse((root/'downloads').exists())
            self.assertFalse((root/'backups').exists())
            self.assertFalse((root/'runtime/tmp').exists())
            self.assertEqual(store.migrate_layout(root)['library_id'],marker['library_id'])
    def test_missing_not_marked_complete(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);self.fixture(root,True);store.migrate_layout(root)
            with sqlite3.connect(root/'runtime/data.db') as c:
                self.assertEqual(c.execute('select status from download_task').fetchone()[0],6)
                self.assertEqual(c.execute('select status from download_resource').fetchone()[0],3)
    def test_master_change_copies_verifies_and_rebases(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)/'old';root.mkdir();self.fixture(root);store.prepare_master(root)
            target=(Path(tmp)/'new').resolve()
            cfg=store.read_config(root/'config.yaml');cfg['workdir']=str(target);store.atomic_json(root/'config.yaml',cfg)
            selected,_=store.prepare_master(root);self.assertEqual(selected,target)
            with sqlite3.connect(target/'runtime/data.db') as c:
                directory,name=c.execute('select download_dir,name from download_resource').fetchone()
                self.assertTrue(Path(directory).is_relative_to(target));self.assertTrue((Path(directory)/name).is_file())
            self.assertTrue((root/'runtime/data.db').is_file())
    def test_refuses_active_tasks(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);self.fixture(root)
            with sqlite3.connect(root/'data.db') as c:c.execute('update download_task set status=2')
            with self.assertRaisesRegex(RuntimeError,'未完成'):store.migrate_layout(root)
            self.assertTrue((root/'downloads/long title.mp4').exists())
    def test_wal_database_is_closed_before_move(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);self.fixture(root)
            with store.database(root/'data.db') as c:c.execute('pragma journal_mode=WAL')
            store.migrate_layout(root)
            with store.database(root/'runtime/data.db') as c:
                self.assertEqual(c.execute('pragma integrity_check').fetchone()[0],'ok')
                self.assertEqual(c.execute('select count(*) from content').fetchone()[0],1)
    def test_switch_existing_library_and_missing_locator(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=(Path(tmp)/'a').resolve();root.mkdir();self.fixture(root);store.prepare_master(root)
            other=(Path(tmp)/'b').resolve();other.mkdir();self.fixture(other);store.prepare_master(other)
            cfg=store.read_config(root/'config.yaml');cfg['workdir']=str(other);store.atomic_json(root/'config.yaml',cfg)
            selected,_=store.prepare_master(root);self.assertEqual(selected,other)
            store.atomic_json(root/'runtime/launcher.json',{'master':str(Path(tmp)/'missing')})
            with self.assertRaisesRegex(RuntimeError,'不存在'):store.prepare_master(root)
    def test_target_collision_preserves_original(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);self.fixture(root)
            target=root/'library/wxchannels'/store.account_folder('wxchannels:a','昵称')/'videos/123_720p.mp4'
            target.parent.mkdir(parents=True);target.write_bytes(b'unknown')
            with self.assertRaisesRegex(RuntimeError,'冲突'):store.migrate_layout(root)
            self.assertEqual(target.read_bytes(),b'unknown')
            self.assertEqual((root/'downloads/long title.mp4').read_bytes(),b'original video')
            self.assertFalse((root/'master.json').exists())
    def test_stable_names(self):
        self.assertEqual(store.stable_id('123_xWT111'),'123_xWT111')
        self.assertEqual(len(store.stable_id('../unsafe')),64)
        self.assertLessEqual(len(store.account_folder('id','很长'*100).encode()),82)
    def test_audit_accepts_rendered_wxmp_size_change(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);runtime=root/'runtime';runtime.mkdir()
            archive=root/'article.html'
            archive.write_text('<main class="wxmp-article-shell"><div id="js_content" class="rich_media_content">正文</div></main>')
            with sqlite3.connect(runtime/'data.db') as c:
                c.executescript('''create table download_task(id integer,platform_id text,status integer,error_message text,deleted_at integer);
                create table download_resource(id integer,task_id integer,download_dir text,name text,kind text,status integer,size integer,deleted_at integer);''')
                c.execute('insert into download_task values(1,\'wxmp\',5,\'\',null)')
                c.execute('insert into download_resource values(1,1,?,?,?,2,10,null)',(str(root),archive.name,'html'))
            store.audit_downloaded_files(root)
            with sqlite3.connect(runtime/'data.db') as c:
                self.assertEqual(c.execute('select status from download_task').fetchone()[0],5)
                self.assertEqual(c.execute('select status from download_resource').fetchone()[0],2)
            self.assertFalse((root/'backups').exists())
if __name__=='__main__':unittest.main()
