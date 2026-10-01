# Client IP, proxy trust, and login rate limiting — problem statement and options

**Date:** 2026-08-14
**Status:** research summary for further investigation. Nothing here is implemented.
**Audience:** written to be read cold, without prior context.

---

## 1. The problem in plain terms

This is a restaurant POS: a Node.js + Express server with MySQL, plus a Vue front end. Staff log in on in-venue terminals using a short numeric PIN, which is their only credential (there is no username/password pair — the PIN *is* the identity).

It ships to **two very different environments**:

| Deployment | Network shape |
| --- | --- |
| Self-hosted Windows install | The app faces terminals directly on the venue LAN. It sees each terminal's real address. |
| Hostinger (hosted) | The app sits behind Hostinger's reverse proxy. The proxy accepts the HTTPS connection from the customer and forwards it to the app over an internal connection. |

In the hosted case, **every request arrives at the app looking like it came from the proxy**, not from the actual person. The real client address, if it is passed along at all, arrives in an HTTP header (`X-Forwarded-For`).

Headers can be forged by anyone. So Express refuses to believe that header unless you explicitly tell it which upstream address is allowed to set it. That setting is `app.set('trust proxy', …)`. In this codebase it is currently fed from an environment variable, `TRUST_PROXY`, which the operator must fill in with Hostinger's proxy IP or CIDR before deployment.

**Three separate features depend on the app knowing the real client address:**

1. **Login rate limiting.** Failed-login counters are keyed on the client IP.
2. **Audit trail.** Almost every admin action writes `ip_address` into the `audit_events` table.
3. **HTTPS redirect.** The app decides whether a request arrived over HTTPS via `req.protocol`, which also depends on trusting the proxy.

**The complaint driving this research:** requiring an operator to discover and configure Hostinger's proxy address is fragile and hard to set up. Is there a cheaper, more professional approach?

---

## 2. What happens when it is wrong

Both failure directions are real and were observed in this codebase.

**If the app trusts too much** (e.g. `trust proxy: true`), any client can send a fake `X-Forwarded-For` header and appear to be a different IP on every request. IP-based rate limiting then counts nothing, because every attempt looks like a new visitor.

**If the app trusts too little** (the setting is missing or `false` while a proxy is actually in front), then:
- Every customer, cashier and admin collapses into one IP — the proxy's. Per-IP limits become shared by the whole venue.
- Every `audit_events` row records the proxy's address instead of the device that acted, which quietly destroys the forensic value of the audit log.
- `req.protocol` always reports `http` even for genuine HTTPS traffic, so an app-level "redirect to HTTPS" rule redirects forever in a loop and the site becomes unreachable.

The current branch already added a startup guard that refuses to boot in the redirect-loop configuration, so that specific failure is now loud instead of silent.

---

## 3. Evidence gathered

### 3.1 Hostinger does not publish what is needed

Official Hostinger support pages were fetched directly (not read from search snippets). Findings:

- Hostinger runs **LiteSpeed** as its web server ([hostinger.com/blog/introducing-litespeed](https://www.hostinger.com/blog/introducing-litespeed)).
- There are three different Node.js offerings ([hostinger.com/support/1583661-is-node-js-supported-at-hostinger](https://www.hostinger.com/support/1583661-is-node-js-supported-at-hostinger)): managed hosting (deploy via hPanel/GitHub), VPS (you install and configure nginx yourself), and Agency hosting (static export only).
- For the **managed** product, Hostinger documents **none** of the following: which proxy technology fronts the app, whether it connects over loopback (`127.0.0.1`) or an internal network address, whether that address is stable over time, or which forwarded headers it sets.
- **No Hostinger article publishes a proxy IP or CIDR**, and there is no recommended `trust proxy` value for their platform.

This is a confirmed documentation gap, not an incomplete search.

### 3.2 The forwarded header may not even be set

The managed deploy guide describes an auto-created `.htaccess` that routes to the node directory, which points to LiteSpeed's **rewrite-proxy** method. LiteSpeed's own documentation states that this method does **not** automatically set `X-Forwarded-For`; custom headers require explicit `RequestHeader` directives ([docs.litespeedtech.com/lsws/cp/cpanel/rewrite-proxy](https://docs.litespeedtech.com/lsws/cp/cpanel/rewrite-proxy/)).

**Implication:** on Hostinger managed hosting it is unconfirmed whether the app receives the real client IP *at all*. If the header is absent, then no value of `TRUST_PROXY` helps — you would be configuring the app to interpret data it never receives.

*(A search result claiming Hostinger's proxy "does not forward the original client address" was found and deliberately discarded: the page returned 403 on direct fetch and the site reads as auto-generated SEO content rather than genuine reported experience.)*

### 3.3 Express's own guidance

From [expressjs.com/en/guide/behind-proxies.html](https://expressjs.com/en/guide/behind-proxies.html), the accepted values are:

| Value | Behaviour | Documented risk |
| --- | --- | --- |
| `false` (default) | Trusts nothing; IP is the socket address. | Collapses all clients behind a proxy into one address. |
| `true` | Trusts the leftmost `X-Forwarded-For` entry. | If the last proxy does not overwrite the header, "it may be possible for the client to provide any value." |
| Hop count (`1`, `2`, …) | Counts N hops from the right. | If a shorter path to the app exists, the client can forge the resolved IP. |
| IP/CIDR list, or presets `loopback` / `linklocal` / `uniquelocal` | Walks the header right-to-left, skipping trusted entries. | Breaks (loudly) if the topology changes. |
| Custom function | Caller-defined. | — |

Express does **not** rank these. However the failure modes are asymmetric: a wrong hop count fails *silently and insecurely*, while a stale IP list fails *loudly and safely*. This is why the current code deliberately rejects `true` and hop counts — a hardening choice stricter than the docs require.

### 3.4 The spoofing attack is real and current

- Live advisories confirm that rotating `X-Forwarded-For` defeats IP-keyed rate limits under permissive trust configuration — including against **Mastodon** (GHSA-c2r5-cfqr-c553) and **Litestar** (GHSA-hm36-ffrh-c77c).
- [OWASP](https://owasp.org/www-community/pages/attacks/ip_spoofing_via_http_headers) catalogues 80+ spoofable client-IP headers (`X-Forwarded-For`, `X-Real-IP`, `True-Client-IP`, `CF-Connecting-IP`, `Client-IP`, …).
- [MDN](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/X-Forwarded-For): "no part of the X-Forwarded-For IP list can be considered trustworthy" unless appended by a proxy you control.
- `express-rate-limit`, the most widely used Express limiter, ships validators that actively warn on this: `ERR_ERL_PERMISSIVE_TRUST_PROXY` when `trust proxy === true`, and `ERR_ERL_UNEXPECTED_X_FORWARDED_FOR` when the header is present but trust is disabled.

**The consistent principle across every source: trust follows enforced network topology, never a header name.**

### 3.5 Security standards say not to key on IP anyway

- **OWASP Authentication Cheat Sheet:** "The counter of failed logins should be associated with the account itself, rather than the source IP address, in order to prevent an attacker from making login attempts from a large number of different IP addresses."
- **OWASP Credential Stuffing Cheat Sheet:** IP blocking "should not be used as the sole or primary defense due to the ease in circumvention."
- **OWASP ASVS 4.0 V2.2:** requires soft lockout *plus* increasing delay *plus* risk signals — never IP alone.
- **NIST SP 800-63B:** a verifier "SHALL limit consecutive failed authentication attempts… to no more than 100," and explicitly endorses progressively increasing delay as an alternative to hard lockout.

### 3.6 Where short numeric PINs stand

NIST SP 800-63B §3.2.10 defines an **activation secret**: a PIN that locally unlocks a device-bound cryptographic key and is *never transmitted to the verifier*. Such a secret "MAY be entirely numeric," needs only 4+ characters, and is capped at 10 consecutive failures.

This system is **close to that shape but not squarely inside it**: it already binds sessions to a registered browser key (ECDSA P-256 held in IndexedDB), and in `enforced` mode the server refuses a PIN-only login outright. But the PIN is still transmitted to the server rather than only unlocking a local key.

**The practical consequence: enabling `enforced` mode is what makes a short PIN defensible.** Once a valid device signature is cryptographically required, guessing a PIN alone gains an attacker nothing, and rate limiting becomes a secondary defence rather than the thing standing between an attacker and the data.

### 3.7 A weakness in the current counters

Two issues, independent of proxy configuration:

1. **A successful login clears the shared per-IP counter.** Because all staff at one venue share an egress IP, any cashier's ordinary successful login resets the venue-wide failure count to zero. The per-IP lockout therefore rarely fires in either direction — weak as a control, and less prone to false lockouts than first assumed. Clearing a *shared* counter on one account's success is a documented bypass class.
2. **Counters live in memory** (module-scope JavaScript `Map`s). Every process restart or deploy wipes them, handing an attacker a fresh window.

### 3.8 Stronger mechanisms exist but are unavailable here

- **PROXY protocol (v1/v2)** carries the true client address at the TCP layer, beneath HTTP, so no header trust is involved. It requires both the upstream proxy and the app's listener to be configured for it — impossible on managed hosting where you do not control the edge. Viable only on a self-managed VPS.
- **Unix-socket peer credentials** identify only the local process on the other end, not the remote client. Not applicable.
- **Cloudflare's `CF-Connecting-IP`** is authoritative *if* the origin refuses connections that do not come from Cloudflare. But Hostinger offers no Cloudflare integration for shared/managed hosting — only a Cloudflare Tunnel Docker app on VPS. Note also that Cloudflare **appends** to `X-Forwarded-For` rather than overwriting it, so that header stays attacker-influenced even behind Cloudflare.
- **LiteSpeed per-IP throttling** and **fail2ban** are real but require server config access, so VPS only, and neither is confirmed to target a specific URL like the login route.

---

## 4. Options

Ordered roughly by value for effort. A, B and C together would remove the mandatory environment variable entirely.

### A. Key login throttling on the account, not the IP *(recommended, code-only)*
Count failures against the user identity being attempted instead of the source address. Directly follows OWASP guidance, works identically on LAN and hosted deployments, and removes the security dependency on proxy configuration. Also fixes the shared-counter bypass in §3.7, since one account's success would no longer clear another's count.
**Cost:** low. The existing helper `createIpRateLimiter` already accepts a `keyForRequest` override, and the login path already computes a per-user key alongside the per-IP one.
**Caveat:** an attacker can still lock a *known* account out by deliberately failing against it, so pair with increasing delay rather than a hard block.

### B. Move HTTPS enforcement out of the application *(code-only + one hosting setting)*
The redirect loop exists only because the app judges the protocol from `req.protocol`, which requires trusted proxy data. Forcing HTTPS at the hosting layer (`.htaccess` or the hPanel setting) does the same job without the app knowing anything about proxies.
**Cost:** low. Removes the second reason the variable is mandatory.

### C. Default `trust proxy` to `loopback` in code, with no environment variable
`loopback` means "trust forwarded headers only from `127.0.0.1`/`::1`." It is safe in **both** deployments: on the Windows LAN, terminals are not loopback, so nothing is trusted and behaviour is identical to today; on hosted, *if* the proxy hands off locally, real client IPs are recovered for free. Forging a header would require already being on the server.
**Cost:** one line.
**Caveat:** whether Hostinger's proxy is local is **unverified** (§3.1). If it is not, this fails safely — you get the proxy's address, which is today's behaviour, not a vulnerability.

### D. Log the observed peer address once
On the first request carrying forwarded headers, log the peer address and the headers seen. Turns "research Hostinger's proxy IP" into "read the line the server printed," should precise attribution ever be wanted.
**Cost:** a few lines. Pairs well with C.

### E. Persist counters in MySQL instead of memory
Fixes the restart-wipes-everything weakness. `rate-limiter-flexible` has a MySQL store, so no Redis is required. MySQL is already in the stack.
**Cost:** moderate — a dependency plus a table, or a small hand-rolled table.

### F. Enable `enforced` device-binding mode *(the actual security control)*
Already built. With it on, the server rejects PIN-only logins and requires a signature from a registered browser key. This is what makes a short numeric PIN defensible under NIST (§3.6), and it demotes rate limiting to defence-in-depth.
**Cost:** operational rollout, not code — every staff browser must be registered first.

### G. Keep an explicit `TRUST_PROXY` value *(status quo)*
Correct and safe today, and the closest thing to a "real" answer for accurate audit-log attribution. The objection is purely operational: the value is undocumented by Hostinger and must be discovered empirically.

### H. Move to VPS and run your own nginx
Removes all ambiguity: you control the proxy, so `trust proxy: 1` is correct and standard, PROXY protocol becomes possible, and fail2ban/LiteSpeed throttling become available.
**Cost:** high — a hosting migration and ongoing server administration.

---

## 5. Recommended combination

**A + B + C + D.** Together these remove the mandatory environment variable, align the login defence with OWASP, and leave the system safe under every combination of proxy behaviour — including the case where Hostinger never sends the client IP at all. Add **E** when convenient, and pursue **F** as the real security win.

**Accept and document this limitation:** accurate client-IP attribution in `audit_events` may be unobtainable on Hostinger's managed tier. That is a platform constraint, not a bug to engineer around.

---

## 6. Open questions worth further research

1. **Does Hostinger's managed Node proxy connect over `127.0.0.1`, or an internal network address?** This single fact decides whether option C recovers real client IPs or merely fails safe. Undocumented — determine empirically or via Hostinger support.
2. **Does that proxy set `X-Forwarded-For` at all**, and if so does it *overwrite* a client-supplied value or *append* to it? Overwriting is required for the header to be trustworthy.
3. Is the proxy address **stable**, or does it rotate? Determines whether a single IP or a CIDR range is needed.
4. Does Hostinger expose any **login-endpoint-level** rate limiting or WAF rule to shared-hosting customers, as opposed to marketing-level "DDoS protection"?
5. For per-account throttling, what is the right **lockout policy for a POS specifically**? A locked-out cashier during service is a real business cost, so increasing delay plus manager override is likely better than a hard block.

### How to answer questions 1 and 2 empirically

The app already exposes what is needed. `GET /api/system/settings` returns a `client_ip` field computed from `req.ip`. With trust proxy disabled, that value *is* the immediate proxy's address.

1. Deploy with `ENFORCE_HTTPS=false` and no trust-proxy value. (The startup guard only fires when `ENFORCE_HTTPS=true`.)
2. Log in through the real domain and call `GET /api/system/settings`.
3. Read `client_ip` — that is the proxy talking to your app. If it reads `127.0.0.1` or `::1`, option C works and the variable can be dropped.
4. To confirm a configured value later: set it, restart, and call the endpoint again. `client_ip` should flip to *your own public IP*. That flip is the proof.

This is the same verification method `express-rate-limit`'s own troubleshooting guide recommends.
