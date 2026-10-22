"""Manage the private local proxy CA stored in the shared production Master."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time


OPENSSL = "/usr/bin/openssl"
RENEW_BEFORE_DAYS = 30
VALID_DAYS = 365


def openssl(*args):
    return subprocess.run(
        [OPENSSL, *map(str, args)],
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=15,
    ).stdout


def valid_for(cert, seconds=0):
    try:
        openssl("x509", "-in", cert, "-checkend", str(seconds), "-noout")
        return True
    except (OSError, subprocess.SubprocessError):
        return False


def verify_pair(cert, key):
    try:
        certificate_public_key = openssl("x509", "-in", cert, "-pubkey", "-noout")
        private_public_key = openssl("pkey", "-in", key, "-pubout")
    except (OSError, subprocess.SubprocessError) as error:
        raise RuntimeError("无法读取工作台证书或私钥；未更换证书。") from error
    if certificate_public_key != private_public_key:
        raise RuntimeError("工作台证书与私钥不匹配；未更换证书。")


def ensure_pair(directory, renew_before_days=RENEW_BEFORE_DAYS, valid_days=VALID_DAYS):
    """Create or safely rotate the private CA; return True when it changed."""
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    directory.chmod(0o700)
    cert, key = directory / "session.crt", directory / "session.key"

    if cert.exists() or key.exists():
        if not cert.is_file() or not key.is_file():
            raise RuntimeError("工作台证书与私钥不完整；不会静默更换证书。")
        verify_pair(cert, key)
        key.chmod(0o600)
        cert.chmod(0o600)
        if valid_for(cert, max(0, int(renew_before_days)) * 24 * 60 * 60):
            return False

    with tempfile.TemporaryDirectory(prefix="certificate-", dir=directory) as temporary:
        stage = Path(temporary)
        config = stage / "openssl.cnf"
        config.write_text(
            "[req]\n"
            "distinguished_name=dn\n"
            "x509_extensions=ca\n"
            "prompt=no\n"
            "[dn]\n"
            "CN=SPH Workbench Local Bridge\n"
            "[ca]\n"
            "basicConstraints=critical,CA:true\n"
            "keyUsage=critical,keyCertSign,cRLSign,digitalSignature\n"
            "subjectKeyIdentifier=hash\n"
            "authorityKeyIdentifier=keyid:always\n"
        )
        staged_cert, staged_key = stage / "session.crt", stage / "session.key"
        openssl(
            "req", "-x509", "-newkey", "rsa:2048", "-nodes",
            "-days", str(int(valid_days)), "-keyout", staged_key,
            "-out", staged_cert, "-config", config,
        )
        staged_cert.chmod(0o600)
        staged_key.chmod(0o600)
        verify_pair(staged_cert, staged_key)
        if not valid_for(staged_cert, max(0, int(renew_before_days)) * 24 * 60 * 60):
            raise RuntimeError("新生成的工作台证书有效期不足；保留原证书。")

        if cert.exists():
            archive = directory / "certificate-history" / str(time.time_ns())
            archive.mkdir(parents=True, mode=0o700)
            archive.parent.chmod(0o700)
            archive.chmod(0o700)
            shutil.copy2(cert, archive / cert.name)
            shutil.copy2(key, archive / key.name)
            (archive / cert.name).chmod(0o600)
            (archive / key.name).chmod(0o600)

        os.replace(staged_key, key)
        os.replace(staged_cert, cert)
        key.chmod(0o600)
        cert.chmod(0o600)
    return True
