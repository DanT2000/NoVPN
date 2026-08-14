# NoVPN: a self-hosted panel for AmneziaWG and Xray where the user issues their own key

> Article draft (EN). Paste as is; screenshot slots are marked
> `![caption](press/screenshots/...)`.

I got tired of handing out keys by hand.

I run a couple of VPN servers for family and friends. The usual story: someone needs access,
you SSH into the server, generate a config, send the file, explain where to import it — then
their device changes and you do it all again. And I specifically wanted **AmneziaWG**
(obfuscated WireGuard) — it survives better than plain WG on restrictive networks. Plus
**Xray/Reality** as a second channel.

So I went looking for a panel. And ran into an annoying problem.

## Why existing panels didn't fit

3X‑UI, Marzban and friends are good projects, but they're built around **Xray/VLESS**.
AmneziaWG is either missing or bolted on without proper key issuance. I needed the opposite:
Amnezia as the primary protocol **with humane issuance**, and Xray as a bonus.

The second thing that bugged me about every option: **the admin issues the keys**. That's me.
Every time. I wanted the user to get one link and then do it themselves, from any device,
without my involvement and without mandatory Telegram.

That's how **NoVPN** was born. Not "yet another do‑everything panel," but a tool with two
clear ideas: self‑service and one‑click install.

Repo: **https://github.com/DanT2000/0VPN**

## Idea #1: self‑service via a link

The admin creates a user and sends them **one personal link** like `/k/<token>`. They open it
in a browser and land in a cabinet with no password (the token is long, brute force is
pointless). Inside — one big "Connect device" button: pick a protocol, get a config, import it.

For Xray it's **one subscription link for all devices**: the app (Happ, V2RayTun, etc.) pulls
and updates configs itself. For AmneziaWG — a `.conf` or a `vpn://` link for AmneziaVPN.

![User cabinet](screenshots/cabinet.png)

Telegram is optional. There is a bot (issue configs, "My devices" with deletion, `/id`), but
it's an option, not a login requirement.

## Idea #2: one‑click install

The panel installs with a single command on a clean server:

```bash
curl -fsSL https://raw.githubusercontent.com/DanT2000/0VPN/main/install.sh | sudo bash
```

The script installs Docker, builds the image, starts the container and — importantly —
**generates all secrets itself**. No `.env`, no "generate ENCRYPTION_KEY with openssl". The
encryption key is created on first start and stored in a volume next to the DB; the session
secret is derived from it. You can control them manually, but by default it's "unpack and
run." You can even put the panel on the same box that runs the VPN.

Then you add a server **from the web UI**: host, SSH access, protocols, "Install." Over SSH the
panel sets up Xray, AmneziaWG, optionally 3proxy/stunnel, generates keys and configures
Reality. No agent on the servers — SSH only.

![Add‑server wizard](screenshots/server-wizard.png)

## Bypass and failover

The Xray subscription is served not as a link list but as a **full config** with routing:

- Russian domains (list editable in the admin UI) go **direct**, bypassing the VPN — so
  government/banking/marketplace sites don't break or waste foreign traffic.
- Everything else goes through Reality.
- If Xray gets blocked, traffic **fails over** along a chain: another Xray server → HTTPS
  proxy → HTTP → SOCKS → direct as a last resort. Built on Xray observatory + balancers with
  a `fallbackTag` chain.

The tricky part was **sniffing**: without `destOverride` and `routeOnly: true`, domain rules
don't fire in TUN mode (the router sees only IPs), and whitelisted sites went through the
tunnel instead of direct. A small thing that broke the whole "whitelist" idea until I figured
it out.

## Quotas that actually work

WireGuard has no notion of "cut off by traffic" — a peer either exists or it doesn't. So quotas
are done honestly: when a user hits their limit, the panel **removes their peer from the
server**; when the limit is restored, the peer **comes back with the same key**, and the
client `.conf` keeps working without re‑issue. Keys stay encrypted in the DB the whole time.

## Security

- Secrets in the DB (SSH passwords/keys, bot token, proxy passwords) are encrypted with
  **AES‑256‑GCM** and never returned by the API after saving.
- The default admin password is `admin`, but until it's changed the panel **serves nothing**
  except the change‑password screen — a known default must not be a backdoor.
- Anti‑fixation sessions, the subscription token separated from the login token, config
  responses marked `Cache-Control: no-store`.

Before going public I ran a multi‑agent audit over the code and fixed everything it found
(including one real hole: re‑issuing a config bypassed disable/quota).

## What NoVPN doesn't do

Honestly: it's not an everything‑box. No multi‑tenancy, billing, or dozens of protocols.
Management lives in the web panel, not Telegram (simpler and safer). No per‑day traffic
breakdown yet — that needs history collection, it's on the roadmap. The project is narrow and
about one thing: **making issuance and operation simple**.

## Wrap‑up

If, like me, you wanted AmneziaWG with a proper panel and self‑service keys — grab it:

**https://github.com/DanT2000/0VPN**

One command to install, everything else via the web. Issues/PRs welcome.
