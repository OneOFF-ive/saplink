; Wait for the GUI host: no console allocation and no inherited nsExec output pipes.
!macro RunInstallerControl Script Arguments
  StrCpy $1 ""
  Delete "$PLUGINSDIR\installer-control-result.txt"
  ClearErrors
  ExecWait '"$PLUGINSDIR\installer-host.exe" "${Script}" ${Arguments} -ReportPath "$PLUGINSDIR\installer-control-result.txt"' $0
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

