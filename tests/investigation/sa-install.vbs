' sa-install.vbs — Types path into folder dialog and confirms
Set WshShell = WScript.CreateObject("WScript.Shell")

' Wait for folder dialog
WScript.Sleep 3000

' Focus address bar in folder dialog (Alt+D)
WshShell.SendKeys "%d"
WScript.Sleep 500

' Type path
WshShell.SendKeys "C:\Users\marco\AppData\Local\openMCPWEBLOCK\sa-extension"
WScript.Sleep 500

' Press Enter to navigate
WshShell.SendKeys "{ENTER}"
WScript.Sleep 2000

' Press Enter to select folder
WshShell.SendKeys "{ENTER}"
WScript.Sleep 500

WScript.Echo "Done"
