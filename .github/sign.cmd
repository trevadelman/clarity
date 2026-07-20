@echo off
rem Selective Authenticode signing via DigiCert KeyLocker (metered quota).
rem Signs only what Windows actually validates: the app exe and the NSIS
rem installer. NSIS plugin DLLs are embedded inside the installer and are
rem never signature-checked by the OS — skip them to save signatures.

echo %1 | findstr /i /c:"\\Plugins\\" >nul
if not errorlevel 1 (
  echo Skipping signature for embedded NSIS plugin: %1
  exit /b 0
)

smctl sign --fingerprint %SM_CODE_SIGNING_CERT_SHA1_HASH% --input %1
