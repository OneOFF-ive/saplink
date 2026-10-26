; Wait for PowerShell itself, without inheriting nsExec output pipes.
!macro RunInstallerControl Script Arguments
  StrCpy $1 ""
  Delete "$PLUGINSDIR\installer-control-result.txt"
  ClearErrors
  ExecWait '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "${Script}" ${Arguments} -ReportPath "$PLUGINSDIR\installer-control-result.txt"' $0
  ${If} ${Errors}
    StrCpy $0 "error"
    StrCpy $1 "无法启动安装控制脚本。"
  ${Else}
    IfFileExists "$PLUGINSDIR\installer-control-result.txt" 0 +4
      FileOpen $2 "$PLUGINSDIR\installer-control-result.txt" r
      FileReadUTF16LE $2 $1
      FileClose $2
  ${EndIf}
!macroend

