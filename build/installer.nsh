; CodeFox custom NSIS installer additions
; This file is included by electron-builder automatically

; Run dependency setup after installation completes
!macro customInstall
  ; Copy the setup script to the install directory
  File /oname=$INSTDIR\setup-dependencies.ps1 "${BUILD_RESOURCES_DIR}\setup-dependencies.ps1"

  ; Ask user if they want to run dependency setup
  MessageBox MB_YESNO|MB_ICONQUESTION \
    "CodeFox requires Ollama and an AI model to work.$\n$\nWould you like to check and install dependencies now?$\n$\n(You can also do this later from the CodeFox app)" \
    IDNO skip_deps

  ; Run the PowerShell setup script
  nsExec::ExecToLog 'powershell.exe -ExecutionPolicy Bypass -WindowStyle Normal -File "$INSTDIR\setup-dependencies.ps1"'

  skip_deps:
!macroend

!macro customUnInstall
  ; Clean up setup script on uninstall
  Delete "$INSTDIR\setup-dependencies.ps1"
!macroend
