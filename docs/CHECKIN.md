# Jake's check-in
Max 3 items. Each is a yes/no or a 1-minute test. Newest at top.

## Mon 16 Nov — HUB live and auto-deploying. DSOS requests sent to DSOS Build.
1. **DSOS hookup is building (16 Nov).** When it says Step 1 is done, 1-minute test on the HUB:
   `(Invoke-RestMethod http://127.0.0.1:5680/api/connectors -Headers @{ 'x-api-key' = (Get-Content C:\Flow\secrets\api-key.txt) }).dsos`
   → `configured : True`. That starts the shadow trials (Xero 7 days, recurring invoices 31 days).
