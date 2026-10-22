"""Restore pre-launch macOS HTTP proxies after the Host exits, even on SIGKILL."""
import json
import os
from pathlib import Path
import subprocess
import sys
import time

KINDS = ('web', 'secureweb')

def run(*args):
    return subprocess.run(['/usr/sbin/networksetup', *args], check=True, capture_output=True, text=True, timeout=20).stdout

def read(service, kind):
    fields = dict(line.split(': ', 1) for line in run('-get'+kind+'proxy', service).splitlines() if ': ' in line)
    return {'enabled': fields.get('Enabled') == 'Yes', 'host': fields.get('Server',''),
            'port': fields.get('Port','0'), 'authenticated': fields.get('Authenticated Proxy Enabled') == '1'}

def alive(pid):
    try: os.kill(pid, 0); return True
    except ProcessLookupError: return False
    except PermissionError: return True

def restore(state):
    for service, protocols in state['services'].items():
        for kind, previous in protocols.items():
            current = read(service, kind)
            # Never overwrite a different proxy selected while the Host was running.
            if (current['host'], current['port']) != (state['host'], str(state['port'])):
                continue
            if previous['host'] and previous['port'] != '0':
                run('-set'+kind+'proxy', service, previous['host'], previous['port'])
            run('-set'+kind+'proxystate', service, 'on' if previous['enabled'] else 'off')

def recover(path):
    if not path.exists(): return
    state = json.loads(path.read_text())
    if alive(state['pid']):
        raise RuntimeError('上一工作台进程仍在运行，不能覆盖代理恢复记录')
    restore(state)
    path.unlink()

def prepare(master, config):
    if sys.platform != 'darwin': return None
    path = master/'runtime/proxy-restore.json'
    recover(path)
    proxy = config.get('proxy', {})
    if not proxy.get('system') or proxy.get('tun'): return None
    host, port = proxy.get('hostname','127.0.0.1'), str(proxy.get('port',2023))
    services = {}
    for name in run('-listallnetworkservices').splitlines()[1:]:
        if not name or name.startswith('*'): continue
        protocols = {kind: read(name,kind) for kind in KINDS}
        for value in protocols.values():
            if value['authenticated']:
                raise RuntimeError('现有代理带认证，无法安全自动恢复；未启动 Host')
            if (value['host'],value['port']) == (host,port) and value['enabled']:
                raise RuntimeError('发现未恢复的 Host 代理，请先恢复原代理后启动')
        services[name] = protocols
    from master_store import atomic_json
    atomic_json(path, {'pid':os.getpid(),'host':host,'port':port,'services':services})
    log = master/'runtime/proxy-restore.log'
    try:
        with log.open('ab') as output:
            guard = subprocess.Popen([sys.executable,str(Path(__file__).resolve()),str(path)],
                                     stdin=subprocess.DEVNULL,stdout=output,stderr=subprocess.STDOUT,
                                     start_new_session=True,close_fds=True)
        # The monitor acknowledges startup before the Host can change any settings.
        ready = path.with_suffix('.ready')
        for _ in range(100):
            if ready.exists(): ready.unlink(); return path
            if guard.poll() is not None: break
            time.sleep(.05)
        raise RuntimeError('代理恢复监护启动失败，未启动 Host')
    except Exception:
        if 'guard' in locals(): guard.terminate()
        path.unlink(missing_ok=True)
        raise

def watch(path):
    state = json.loads(path.read_text())
    path.with_suffix('.ready').touch(mode=0o600)
    while alive(state['pid']): time.sleep(.5)
    # Allow normal native shutdown to finish first. Retry transient service errors.
    for attempt in range(10):
        try:
            restore(state)
            path.unlink(missing_ok=True)
            print('已恢复 Host 启动前的系统代理。',flush=True)
            return
        except Exception as error:
            print('代理恢复重试：'+str(error),flush=True)
            time.sleep(1)
    print('代理恢复失败；记录已保留供下次启动恢复。',flush=True)

if __name__ == '__main__': watch(Path(sys.argv[1]))
