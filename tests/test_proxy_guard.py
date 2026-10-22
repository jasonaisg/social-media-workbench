import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import proxy_guard as guard


def setting(host='127.0.0.1',port='7897',enabled=True):
    return dict(host=host,port=port,enabled=enabled,authenticated=False)

class ProxyRestoreTests(unittest.TestCase):
    def state(self):
        return dict(pid=123,host='127.0.0.1',port='2023',services={'Wi-Fi':{'web':setting(),'secureweb':setting()}})

    @patch.object(guard,'run')
    @patch.object(guard,'read',return_value=setting(port='2023'))
    def test_restores_previous_proxy_not_just_disable(self,read,run):
        guard.restore(self.state())
        self.assertEqual([c.args for c in run.call_args_list],[('-setwebproxy','Wi-Fi','127.0.0.1','7897'),('-setwebproxystate','Wi-Fi','on'),('-setsecurewebproxy','Wi-Fi','127.0.0.1','7897'),('-setsecurewebproxystate','Wi-Fi','on')])

    @patch.object(guard,'run')
    @patch.object(guard,'read',return_value=setting(port='2023',enabled=False))
    def test_restores_after_native_cleanup_disabled_proxy(self,read,run):
        guard.restore(self.state());self.assertEqual(run.call_count,4)

    @patch.object(guard,'run')
    @patch.object(guard,'read',side_effect=[setting(port='8888'),setting(port='2023')])
    def test_preserves_user_change_per_protocol(self,read,run):
        guard.restore(self.state());self.assertEqual(run.call_count,2)
        self.assertEqual(run.call_args_list[0].args[0],'-setsecurewebproxy')

    @patch.object(guard,'run')
    @patch.object(guard,'read',return_value=setting(port='2023'))
    def test_previously_disabled_stays_disabled(self,read,run):
        s=self.state();s['services']['Wi-Fi']['web']['enabled']=False
        guard.restore(s);self.assertEqual(run.call_args_list[1].args[-1],'off')

    @patch.object(guard,'restore')
    @patch.object(guard,'alive',return_value=False)
    def test_recovers_journal_after_guard_was_killed(self,alive,restore):
        with tempfile.TemporaryDirectory() as tmp:
            p=Path(tmp)/'state.json';p.write_text(json.dumps(self.state()))
            guard.recover(p);restore.assert_called_once();self.assertFalse(p.exists())

    @patch.object(guard,'restore')
    @patch.object(guard,'alive',return_value=True)
    def test_does_not_override_live_host(self,alive,restore):
        with tempfile.TemporaryDirectory() as tmp:
            p=Path(tmp)/'state.json';p.write_text(json.dumps(self.state()))
            with self.assertRaises(RuntimeError):guard.recover(p)
            restore.assert_not_called();self.assertTrue(p.exists())

    @patch.object(guard.time,'sleep')
    @patch.object(guard,'restore',side_effect=[OSError('transient'),None])
    @patch.object(guard,'alive',side_effect=[True,False])
    def test_monitor_retries_after_host_exit(self,alive,restore,sleep):
        with tempfile.TemporaryDirectory() as tmp:
            p=Path(tmp)/'state.json';p.write_text(json.dumps(self.state()))
            guard.watch(p);self.assertEqual(restore.call_count,2);self.assertFalse(p.exists())

if __name__=='__main__':unittest.main()
