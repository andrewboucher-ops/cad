# Microsoft 365 / Entra ID single sign-on

Sits alongside the local username/password login — it never replaces it, and it
never creates accounts on its own. A Microsoft sign-in only succeeds if its
account email matches the `email` field already set on an existing CCCS user.
No linked email, no way in via Microsoft — the account still works with its
local password.

## 1. Register the app in Entra ID

1. Go to [entra.microsoft.com](https://entra.microsoft.com) (or the Microsoft
   Entra ID blade in the Azure portal) → **App registrations** → **New
   registration**.
2. Name it something recognisable, e.g. `CCCS control room`.
3. Supported account types: **Accounts in this organizational directory only**
   (single tenant). This is a control-room app for your own staff, not a
   multi-tenant SaaS product.
4. Redirect URI: platform **Web**, URI:
   ```
   https://comms.echeloncic.com/api/auth/microsoft/callback
   ```
5. Click **Register**.

## 2. Collect the two IDs

On the app's **Overview** page, copy:
- **Application (client) ID**
- **Directory (tenant) ID**

## 3. Create a client secret

**Certificates & secrets** → **New client secret** → give it a description and
an expiry (24 months is reasonable) → **Add**. Copy the **Value** immediately —
it is shown once and cannot be retrieved again.

## 4. Permissions

Nothing to add. The app requests the `openid profile email` scopes, which are
standard OpenID Connect scopes every Entra ID app can use without admin
consent — no Graph API permissions are required for sign-in alone.

## 5. Configure CCCS

On the container (`/etc/cccs/cccs.env`), un-comment and fill in the four lines
already scaffolded there:

```
MS_TENANT_ID=<Directory (tenant) ID>
MS_CLIENT_ID=<Application (client) ID>
MS_CLIENT_SECRET=<the secret value from step 3>
MS_REDIRECT_URI=https://comms.echeloncic.com/api/auth/microsoft/callback
```

Then:
```bash
systemctl restart cccs
```

Check the startup log line — it should read `Microsoft SSO: enabled (tenant
<id>)` instead of "not configured". `GET /api/auth/microsoft/status` also
reports `{"enabled":true}` once this is done, and the login page automatically
shows a "Sign in with Microsoft" button.

## 6. Link accounts

SSO does nothing until an account has an email set. As an admin:

```bash
curl -X PATCH https://comms.echeloncic.com/api/users/<user-id> \
  -H "authorization: Bearer <your admin token>" \
  -H "content-type: application/json" \
  -d '{"email":"person@echeloncic.com"}'
```

Whatever Microsoft 365 account signs in with that same email/UPN will now log
into that CCCS account, with whatever role and radio/MDT binding it already
has. Setting `"email": null` unlinks it again.

New accounts can also be given an email at creation time (`POST /api/users`),
or via `seed.json` — see the `email` field documented in
`seed.example.json`.

## Notes

- If a Microsoft sign-in has no matching CCCS account, the user is bounced
  back to the login page with an explanation — no account is created.
- The id_token Microsoft returns is signature-verified against Entra ID's
  published keys (`msauth.js`) before anything in it is trusted.
- Rotate the client secret before it expires — Entra ID does not warn you.
