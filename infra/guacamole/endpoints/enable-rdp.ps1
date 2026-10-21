# Prepares a Windows PC or server to be reached from Guacamole over RDP.
# Run in an elevated PowerShell, or push through Intune / GPO startup script:
#   powershell -ExecutionPolicy Bypass -File enable-rdp.ps1 -GuacamoleIp 192.168.1.150
#
# RDP is opened ONLY to the Guacamole server, never to the whole network.
param(
    [Parameter(Mandatory = $true)]
    [string]$GuacamoleIp,
    # Domain or local group whose members may RDP in (e.g. "COMPANY\IT Support").
    [string]$AllowGroup
)
$ErrorActionPreference = 'Stop'

# Turn RDP on, with Network Level Authentication.
Set-ItemProperty 'HKLM:\System\CurrentControlSet\Control\Terminal Server' -Name fDenyTSConnections -Value 0
Set-ItemProperty 'HKLM:\System\CurrentControlSet\Control\Terminal Server\WinStations\RDP-Tcp' -Name UserAuthentication -Value 1

# Replace the built-in "allow from anywhere" rules with one scoped to Guacamole.
Disable-NetFirewallRule -DisplayGroup 'Remote Desktop' -ErrorAction SilentlyContinue
Get-NetFirewallRule -DisplayName 'Guacamole RDP' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName 'Guacamole RDP' -Direction Inbound -Protocol TCP -LocalPort 3389 `
    -RemoteAddress $GuacamoleIp -Action Allow -Profile Domain,Private | Out-Null

if ($AllowGroup) {
    Add-LocalGroupMember -Group 'Remote Desktop Users' -Member $AllowGroup -ErrorAction SilentlyContinue
}

Write-Host "RDP enabled for connections from $GuacamoleIp on $env:COMPUTERNAME"
