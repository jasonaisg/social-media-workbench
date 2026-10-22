import importlib.util
import json
from pathlib import Path
import sqlite3
import unittest

spec=importlib.util.spec_from_file_location('metrics',Path(__file__).resolve().parents[1]/'scripts/refresh_metrics.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class MetricsTests(unittest.TestCase):
 def test_extract_identity_and_missing(self):
  payload={'code':0,'data':{'errCode':0,'data':{'object':{'id':'18446744073709551610','likeCount':0,'favCount':True,'forwardCount':12}}}}
  result=m.extract(payload,'18446744073709551610')
  self.assertEqual(result['counts'],{'likeCount':0,'forwardCount':12})
  self.assertEqual(result['status'],'partial')
  with self.assertRaises(ValueError):m.extract(payload,'different')
 def test_apply_preserves_metadata_and_failed_values(self):
  db=sqlite3.connect(':memory:');db.executescript('CREATE TABLE content(id TEXT,metadata TEXT);CREATE TABLE download_task(id INTEGER,content_id TEXT,metadata_json TEXT,deleted_at TEXT);')
  original={'key':'retained','wxchannels_metrics':{'counts':{'favCount':9,'likeCount':4},'fetched_at':1,'field_fetched_at':{'favCount':1}}}
  db.execute('INSERT INTO content VALUES (?,?)',('wxchannels:123',json.dumps(original)))
  db.execute('INSERT INTO download_task VALUES (1,?,?,NULL)',('wxchannels:123',json.dumps({'other':42})));db.commit()
  rows=[{'id':'wxchannels:123','external_id':'123'}]
  m.apply(db,rows,{'123':{'status':'partial','counts':{'likeCount':0},'fetched_at':2}})
  actual=json.loads(db.execute('SELECT metadata FROM content').fetchone()[0]);self.assertEqual(actual['key'],'retained');self.assertEqual(actual['wxchannels_metrics']['counts'],{'favCount':9,'likeCount':0})
  m.apply(db,rows,{'123':{'status':'failed','attempted_at':3,'error':'offline'}})
  actual=json.loads(db.execute('SELECT metadata FROM content').fetchone()[0]);self.assertEqual(actual['wxchannels_metrics']['counts']['favCount'],9)
  self.assertEqual(json.loads(db.execute('SELECT metadata_json FROM download_task').fetchone()[0])['other'],42)
if __name__=='__main__':unittest.main()
