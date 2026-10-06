# Store TL Login (face + password + location)

## Run it
    npm install
    ADMIN_USER=admin ADMIN_PASS='YourStrongPass#1' npm start
Open http://localhost:3000/admin.html (admin) and http://localhost:3000/ (team leads).
If you skip ADMIN_PASS the first admin is `admin` / `ChangeMe@123` - change it at once.

## Shift alerts and exports
Assign each team lead a mobile number in international format (for example `+919876543210`) and one fixed shift in the Admin console. Late-login checks run daily in `Asia/Kolkata` by default: 6:30 AM for the 6:00 AM shift, 10:30 AM for the 10:00 AM shift, and 3:30 PM for the 3:00 PM shift. Set `APP_TIME_ZONE` to another IANA timezone if needed. Configure the admin's alert number under Account. The Sign-in log tab downloads all attempts as a date-filtered CSV that opens in Excel.

SMS alerts use Twilio. Set these environment variables on the server before starting the app; keep the auth token secret:

```powershell
$env:TWILIO_ACCOUNT_SID = 'your-account-sid'
$env:TWILIO_AUTH_TOKEN = 'your-auth-token'
$env:TWILIO_FROM_NUMBER = '+15551234567'
$env:APP_TIME_ZONE = 'Asia/Kolkata'
npm start
```

The server process must remain running for scheduled checks. SMS delivery may incur Twilio charges.

## Team performance reports
After signing in, a team lead can submit one report per date with a breach percentage from 0 to 100. A root-cause analysis is required when the percentage is above 0. Reports can be updated by selecting the same date again. Admins can review reports and filter by date in the Performance tab. The report date defaults to the app's configured timezone (`APP_TIME_ZONE`).

## How it works
1. Admin adds stores (city, name, latitude, longitude, allowed range in metres).
2. Admin creates each team lead (ID, password, store) and enrols their face on camera.
3. Team lead opens the site, enters ID + password, allows location and camera.
4. Server checks: password -> GPS distance to the store <= range -> face match. Any failure is refused and logged.
Data lives in SQLite at data/app.db (admins, stores, users, login_logs).

## Settings (environment variables)
PORT, ADMIN_USER, ADMIN_PASS, FACE_THRESHOLD (default 0.5, lower = stricter),
MAX_GPS_ACCURACY_M (default 150), JWT_SECRET, TRUST_PROXY=1 (behind nginx etc.)

## Deploy notes
- Camera and location only work on HTTPS (or localhost). Put it behind HTTPS.
- Face models and face-api.js load from the jsDelivr CDN. Self-host them for offline/locked-down networks.
- Back up data/app.db regularly. It holds face templates (numbers, not photos) - treat as sensitive personal data.

## Limits to know
- Browser GPS can be faked (mock-location apps, dev tools). Range checks reduce misuse but are not tamper-proof.
- There is no liveness detection, so a printed photo or a screen photo could fool the face check.
  For strict security add a liveness step or a native app with device attestation.
