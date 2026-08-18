# 쿠팡 포스 매출 추출 - 기간 선택 UI (Windows 기본 내장 폼)
# 결과를 "YYYY-MM-DD|YYYY-MM-DD" 형식으로 stdout에 출력한다.
# 취소하거나 창을 닫으면 오늘 날짜로 기본 설정된다.

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$form = New-Object System.Windows.Forms.Form
$form.Text = "쿠팡 포스 매출 추출 - 기간 선택"
$form.Size = New-Object System.Drawing.Size(400, 290)
$form.StartPosition = "CenterScreen"
$form.FormBorderStyle = "FixedDialog"
$form.MaximizeBox = $false
$form.MinimizeBox = $false
$form.Font = New-Object System.Drawing.Font("맑은 고딕", 10)

# --- 안내 문구 ---
$lblInfo = New-Object System.Windows.Forms.Label
$lblInfo.Text = "추출할 기간을 선택하세요. (기본: 오늘)"
$lblInfo.Location = New-Object System.Drawing.Point(25, 18)
$lblInfo.AutoSize = $true
$form.Controls.Add($lblInfo)

# --- 시작일 ---
$lblStart = New-Object System.Windows.Forms.Label
$lblStart.Text = "시작일"
$lblStart.Location = New-Object System.Drawing.Point(25, 58)
$lblStart.AutoSize = $true
$form.Controls.Add($lblStart)

$dtpStart = New-Object System.Windows.Forms.DateTimePicker
$dtpStart.Format = [System.Windows.Forms.DateTimePickerFormat]::Custom
$dtpStart.CustomFormat = "yyyy-MM-dd"
$dtpStart.Location = New-Object System.Drawing.Point(110, 54)
$dtpStart.Size = New-Object System.Drawing.Size(240, 26)
$form.Controls.Add($dtpStart)

# --- 종료일 ---
$lblEnd = New-Object System.Windows.Forms.Label
$lblEnd.Text = "종료일"
$lblEnd.Location = New-Object System.Drawing.Point(25, 94)
$lblEnd.AutoSize = $true
$form.Controls.Add($lblEnd)

$dtpEnd = New-Object System.Windows.Forms.DateTimePicker
$dtpEnd.Format = [System.Windows.Forms.DateTimePickerFormat]::Custom
$dtpEnd.CustomFormat = "yyyy-MM-dd"
$dtpEnd.Location = New-Object System.Drawing.Point(110, 90)
$dtpEnd.Size = New-Object System.Drawing.Size(240, 26)
$form.Controls.Add($dtpEnd)

# --- 빠른 선택 버튼 ---
function New-Preset($text, $x, $startOffsetDays) {
  $b = New-Object System.Windows.Forms.Button
  $b.Text = $text
  $b.Location = New-Object System.Drawing.Point($x, 130)
  $b.Size = New-Object System.Drawing.Size(80, 30)
  $b.Add_Click({
    $today = Get-Date
    $dtpEnd.Value = $today
    $dtpStart.Value = $today.AddDays(-$startOffsetDays)
  }.GetNewClosure())
  return $b
}
$form.Controls.Add((New-Preset "오늘" 25 0))
$form.Controls.Add((New-Preset "최근 7일" 110 6))
$form.Controls.Add((New-Preset "최근 30일" 195 29))

# 어제 버튼(시작=종료=어제)
$btnYest = New-Object System.Windows.Forms.Button
$btnYest.Text = "어제"
$btnYest.Location = New-Object System.Drawing.Point(280, 130)
$btnYest.Size = New-Object System.Drawing.Size(80, 30)
$btnYest.Add_Click({
  $y = (Get-Date).AddDays(-1)
  $dtpStart.Value = $y
  $dtpEnd.Value = $y
})
$form.Controls.Add($btnYest)

# --- 추출 / 취소 ---
$btnOK = New-Object System.Windows.Forms.Button
$btnOK.Text = "추출하기"
$btnOK.Location = New-Object System.Drawing.Point(110, 185)
$btnOK.Size = New-Object System.Drawing.Size(120, 36)
$btnOK.DialogResult = [System.Windows.Forms.DialogResult]::OK
$form.Controls.Add($btnOK)
$form.AcceptButton = $btnOK

$btnCancel = New-Object System.Windows.Forms.Button
$btnCancel.Text = "취소"
$btnCancel.Location = New-Object System.Drawing.Point(240, 185)
$btnCancel.Size = New-Object System.Drawing.Size(110, 36)
$btnCancel.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
$form.Controls.Add($btnCancel)
$form.CancelButton = $btnCancel

$result = $form.ShowDialog()

if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
  $s = $dtpStart.Value.Date
  $e = $dtpEnd.Value.Date
  if ($s -gt $e) { $tmp = $s; $s = $e; $e = $tmp }   # 시작>종료면 교환
  $sStr = $s.ToString("yyyy-MM-dd")
  $eStr = $e.ToString("yyyy-MM-dd")
} else {
  # 취소/창 닫기 → 오늘
  $sStr = (Get-Date).ToString("yyyy-MM-dd")
  $eStr = $sStr
}

Write-Output "$sStr|$eStr"
