from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import bridge_certificate as certificate


class CertificateTests(unittest.TestCase):
    def test_creates_365_day_pair_and_keeps_valid_pair(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            self.assertTrue(certificate.ensure_pair(directory))
            cert, key = directory / "session.crt", directory / "session.key"
            certificate.verify_pair(cert, key)
            self.assertTrue(certificate.valid_for(cert, 30 * 24 * 60 * 60))
            before = (cert.read_bytes(), key.read_bytes())
            self.assertFalse(certificate.ensure_pair(directory))
            self.assertEqual(before, (cert.read_bytes(), key.read_bytes()))
            self.assertEqual(cert.stat().st_mode & 0o777, 0o600)
            self.assertEqual(key.stat().st_mode & 0o777, 0o600)

    def test_rotates_due_pair_and_archives_exact_original(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            certificate.ensure_pair(directory)
            cert, key = directory / "session.crt", directory / "session.key"
            original = (cert.read_bytes(), key.read_bytes())
            with patch.object(certificate, "valid_for", side_effect=[False, True]):
                self.assertTrue(certificate.ensure_pair(directory))
            self.assertNotEqual(original, (cert.read_bytes(), key.read_bytes()))
            histories = list((directory / "certificate-history").glob("*/session.crt"))
            self.assertEqual(len(histories), 1)
            self.assertEqual(histories[0].read_bytes(), original[0])
            self.assertEqual((histories[0].parent / "session.key").read_bytes(), original[1])

    def test_mismatched_pair_is_never_replaced(self):
        with tempfile.TemporaryDirectory() as first, tempfile.TemporaryDirectory() as second:
            first, second = Path(first), Path(second)
            certificate.ensure_pair(first)
            certificate.ensure_pair(second)
            cert, key = first / "session.crt", first / "session.key"
            key.write_bytes((second / "session.key").read_bytes())
            before = (cert.read_bytes(), key.read_bytes())
            with self.assertRaisesRegex(RuntimeError, "不匹配"):
                certificate.ensure_pair(first)
            self.assertEqual(before, (cert.read_bytes(), key.read_bytes()))

    def test_generation_failure_preserves_existing_pair(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            certificate.ensure_pair(directory)
            cert, key = directory / "session.crt", directory / "session.key"
            before = (cert.read_bytes(), key.read_bytes())
            real_openssl = certificate.openssl

            def fail_generation(*args):
                if args and args[0] == "req":
                    raise subprocess.CalledProcessError(1, args)
                return real_openssl(*args)

            with patch.object(certificate, "valid_for", return_value=False), patch.object(certificate, "openssl", side_effect=fail_generation):
                with self.assertRaises(subprocess.CalledProcessError):
                    certificate.ensure_pair(directory)
            self.assertEqual(before, (cert.read_bytes(), key.read_bytes()))

    def test_incomplete_pair_is_never_replaced(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            (directory / "session.crt").write_text("original")
            with self.assertRaisesRegex(RuntimeError, "不完整"):
                certificate.ensure_pair(directory)
            self.assertEqual((directory / "session.crt").read_text(), "original")
            self.assertFalse((directory / "session.key").exists())


if __name__ == "__main__":
    unittest.main()
