"""Refresh downloaded Channels video metrics through the running Host (conda_video)."""
import argparse
import json
from pathlib import Path
import sqlite3
import time
import urllib.parse
import urllib.request

FIELDS = ('likeCount', 'favCount', 'forwardCount', 'commentCount')

def extract(response, expected_id):
    if response.get('code') != 0:
        raise ValueError(response.get('msg') or 'Host 请求失败')
    data = response.get('data') or {}
    if data.get('errCode', 0) != 0:
        raise ValueError(data.get('errMsg') or '微信详情请求失败')
    item = (data.get('data') or data).get('object') or {}
    if str(item.get('id', '')) != expected_id:
        raise ValueError('作品身份不匹配')
    counts = {k: item[k] for k in FIELDS if type(item.get(k)) is int and item[k] >= 0}
    fav = (item.get('objectExtend') or {}).get('favInfo') or {}
    fav = {k: v for k, v in fav.items() if k in ('fingerlikeFavCount', 'starFavCount') and type(v) is int and v >= 0}
    if not counts:
        raise ValueError('详情没有返回互动计数')
    return {'counts': counts, 'fav_info': fav, 'fetched_at': int(time.time()), 'source': 'feed/profile',
            'status': 'ok' if all(k in counts for k in FIELDS[:3]) else 'partial'}


def targets(db):
    db.row_factory = sqlite3.Row
    rows = db.execute("""SELECT DISTINCT c.id,c.external_id,c.external_id2,c.title
        FROM content c JOIN download_task t ON t.content_id=c.id
        JOIN download_resource r ON r.task_id=t.id
        WHERE t.platform_id='wxchannels' AND t.status=5 AND t.deleted_at IS NULL
        AND c.type='video' AND r.kind LIKE 'video/%' ORDER BY t.id""").fetchall()
    result = []
    for row in rows:
        files = db.execute("""SELECT r.download_dir,r.name FROM download_resource r
            JOIN download_task t ON t.id=r.task_id WHERE t.content_id=? AND t.status=5
            AND t.deleted_at IS NULL AND r.kind LIKE 'video/%'""", (row['id'],)).fetchall()
        if any((Path(f['download_dir']) / f['name']).is_file() for f in files):
            result.append(dict(row))
    return result


def apply(db, rows, records):
    # Re-read inside the write transaction: unrelated metadata must survive.
    db.execute('BEGIN IMMEDIATE')
    try:
        for row in rows:
            record = records[row['external_id']]
            current = db.execute('SELECT metadata FROM content WHERE id=?', (row['id'],)).fetchone()
            if not current:
                continue
            metadata = json.loads(current[0] or '{}')
            old = metadata.get('wxchannels_metrics') or {}
            if record['status'] in ('ok', 'partial'):
                merged = dict(old.get('counts') or {})
                merged.update(record['counts'])
                value = dict(record, counts=merged)
                value['field_fetched_at'] = dict(old.get('field_fetched_at') or {})
                value['field_fetched_at'].update({k: record['fetched_at'] for k in record['counts']})
                value['missing_latest'] = [k for k in FIELDS[:3] if k not in record['counts']]
            else:
                value = dict(old, status='failed', attempted_at=record['attempted_at'], error=record['error'])
            metadata['wxchannels_metrics'] = value
            db.execute('UPDATE content SET metadata=? WHERE id=?', (json.dumps(metadata, ensure_ascii=False), row['id']))
            tasks = db.execute('SELECT id,metadata_json FROM download_task WHERE content_id=? AND deleted_at IS NULL', (row['id'],)).fetchall()
            for task in tasks:
                extra = json.loads(task[1] or '{}')
                extra['wxchannels_metrics'] = value
                db.execute('UPDATE download_task SET metadata_json=? WHERE id=?', (json.dumps(extra, ensure_ascii=False), task[0]))
        db.commit()
    except Exception:
        db.rollback()
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--db', required=True, type=Path)
    parser.add_argument('--api', default='http://127.0.0.1:2022')
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--resume', action='store_true', help='Resume unfinished or failed items in this batch')
    parser.add_argument('--reuse', action='store_true', help='Apply the explicitly selected saved batch without new requests')
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(str(args.db) if args.apply else args.db.resolve().as_uri()+'?mode=ro', uri=not args.apply, timeout=30)
    if args.reuse:
        rows = json.loads((args.output/'targets.json').read_text())
        records = json.loads((args.output/'results.json').read_text())
    else:
        if (args.output/'results.json').exists() and not args.resume:
            raise SystemExit('Output batch exists; choose a new directory or explicitly --reuse')
        rows = json.loads((args.output/'targets.json').read_text()) if args.resume else targets(db)
        (args.output/'targets.json').write_text(json.dumps(rows, ensure_ascii=False, indent=2))
        records = json.loads((args.output/'results.json').read_text()) if args.resume else {}
        op = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        for n, row in enumerate(rows, 1):
            if records.get(row['external_id'], {}).get('status') == 'ok':
                continue
            if n > 1:
                time.sleep(5)
            oid = row['external_id']
            try:
                query = urllib.parse.urlencode({'oid': oid, 'nid': row['external_id2']})
                with op.open(args.api+'/api/channels/feed/profile?'+query, timeout=25) as response:
                    raw = response.read()
                (args.output/(oid+'.json')).write_bytes(raw)
                records[oid] = extract(json.loads(raw), oid)
            except Exception as error:
                records[oid] = {'status': 'failed', 'attempted_at': int(time.time()), 'error': str(error)}
            (args.output/'results.json').write_text(json.dumps(records, ensure_ascii=False, indent=2))
            print(f'{n}/{len(rows)} {oid} {records[oid]["status"]}', flush=True)
            if 'socket connection' in records[oid].get('error', ''):
                print('微信连接已断开，保存断点；恢复连接后使用 --resume。', flush=True)
                return
    if args.apply:
        backup = args.output/'before.sqlite'
        if backup.exists():
            raise SystemExit('Backup already exists; refusing to overwrite')
        with sqlite3.connect(backup) as dest:
            db.backup(dest)
            if dest.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                raise RuntimeError('备份校验失败')
        apply(db, rows, records)
        if db.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
            raise RuntimeError('更新后数据库校验失败')
    summary = {state: sum(r['status'] == state for r in records.values()) for state in ('ok', 'partial', 'failed')}
    summary.update(total=len(rows), applied=args.apply)
    (args.output/'summary.json').write_text(json.dumps(summary, indent=2))
    print(summary, flush=True)

if __name__ == '__main__':
    main()
