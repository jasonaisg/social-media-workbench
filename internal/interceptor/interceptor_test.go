package interceptor

import (
	"errors"
	"testing"
)

func TestCertificateRequiresInstallation(t *testing.T) {
	tests := []struct {
		name        string
		trusted     bool
		checkErr    error
		wantInstall bool
		wantErr     bool
	}{
		{name: "trusted certificate", trusted: true},
		{name: "installed but untrusted certificate", trusted: false, wantInstall: true},
		{name: "trust check failed", checkErr: errors.New("keychain unavailable"), wantErr: true},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			gotInstall, err := certificateRequiresInstallation(
				[]byte("certificate"),
				"SPH Workbench Local Bridge",
				func(certData []byte, certName string) (bool, error) {
					if string(certData) != "certificate" {
						t.Fatalf("unexpected certificate data: %q", certData)
					}
					if certName != "SPH Workbench Local Bridge" {
						t.Fatalf("unexpected certificate name: %q", certName)
					}
					return test.trusted, test.checkErr
				},
			)
			if (err != nil) != test.wantErr {
				t.Fatalf("certificateRequiresInstallation() error = %v, wantErr %v", err, test.wantErr)
			}
			if gotInstall != test.wantInstall {
				t.Fatalf("certificateRequiresInstallation() = %v, want %v", gotInstall, test.wantInstall)
			}
		})
	}
}
