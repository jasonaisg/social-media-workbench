package main

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"fmt"
	"math/big"
	"os"
	"path/filepath"
	"time"
)

const certificateName = "SunnyNet"

func main() {
	outputDir := "certs"
	certPath := filepath.Join(outputDir, "SunnyNet.cer")
	keyPath := filepath.Join(outputDir, "private.key")
	if fileExists(certPath) && fileExists(keyPath) {
		return
	}
	if err := os.MkdirAll(outputDir, 0o700); err != nil {
		fail(err)
	}

	privateKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		fail(err)
	}
	serialLimit := new(big.Int).Lsh(big.NewInt(1), 128)
	serialNumber, err := rand.Int(rand.Reader, serialLimit)
	if err != nil {
		fail(err)
	}
	now := time.Now()
	template := x509.Certificate{
		SerialNumber: serialNumber,
		Subject: pkix.Name{
			CommonName:   certificateName,
			Organization: []string{"video-channel-workbench development"},
		},
		NotBefore:             now.Add(-time.Hour),
		NotAfter:              now.Add(10 * 365 * 24 * time.Hour),
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageCRLSign | x509.KeyUsageDigitalSignature,
		BasicConstraintsValid: true,
		IsCA:                  true,
		MaxPathLenZero:        true,
	}

	certDER, err := x509.CreateCertificate(
		rand.Reader,
		&template,
		&template,
		&privateKey.PublicKey,
		privateKey,
	)
	if err != nil {
		fail(err)
	}
	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: certDER})
	keyPEM := pem.EncodeToMemory(&pem.Block{
		Type:  "RSA PRIVATE KEY",
		Bytes: x509.MarshalPKCS1PrivateKey(privateKey),
	})
	if err := os.WriteFile(certPath, certPEM, 0o644); err != nil {
		fail(err)
	}
	if err := os.WriteFile(keyPath, keyPEM, 0o600); err != nil {
		fail(err)
	}
	fmt.Println("generated local development certificate in", outputDir)
}

func fileExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.Mode().IsRegular()
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, "generate development certificate:", err)
	os.Exit(1)
}
