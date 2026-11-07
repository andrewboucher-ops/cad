# Report writing help ("Write it up for me")

Officers see a **Write it up for me** box at the top of the Incident report
and the other report forms. They jot down what happened in any order (or use
their phone keyboard's microphone) and press **Fill in the form from my
notes**. The text boxes below are filled in for them to check, correct, sign
and submit. Nothing is saved until they submit, and tick boxes, times, the SIA
licence and the signature are always left to the officer.

There are two drafters, and neither costs anything to run:

| | Local AI (Ollama) | Template |
|---|---|---|
| Needs | An LXC on the Proxmox host (steps below) | Nothing, it's built in |
| Quality | Proper written sentences, sorted into the right boxes, plus "worth adding" questions | Tidies the notes ("arrived 2215" → "I arrived at 22:15."), sorts them by keyword, opens with the job details |
| Speed | About 30 seconds to 2 minutes on CPU (runs in the background, the form shows a timer) | Instant |
| Data | Stays on our network | Stays in CCCS |

CCCS uses the local AI when `LOCAL_AI_URL` is set. If the AI is down, slow,
busy (more than 2 drafts waiting) or gives an unusable answer, it uses the
template instead and tells the officer, so they always get a draft.

Any number or time in an AI draft that isn't in the notes or the job record
is shown in red as "Check these", because a small model can occasionally
invent a detail.

Notes and drafts are not stored. The audit log records only that a draft was
made, by whom, for which form, and by which drafter.

## Setting up the local AI

**The quick way.** On the Proxmox host shell (web UI → the host → Shell), paste this one line. It does steps 1–4 below for you, sizes the container to the host's free memory, and prints what it did:

```
pct exec 140 -- cat /opt/cccs-src/deploy/install-local-ai.sh > /root/install-local-ai.sh && bash /root/install-local-ai.sh
```

The steps below are the same thing by hand.

You need about **8 GB of RAM** spare for the default model (`qwen2.5:7b`).
With less, use `qwen2.5:3b` (about 3 GB), which is faster but writes less well.

### 1. Create the container (Proxmox web UI, https://192.168.7.24:8006)

**Create CT** (top right):

- CT ID **220**, hostname **local-ai**, set a password
- Template: **debian-12-standard**
- Disk: **40 GB**
- CPU: **6 cores** (more makes drafts faster)
- Memory: **10240 MB**, swap 1024
- Network: static IP **192.168.7.202/24**, gateway as your other containers

Untick nothing else, then **Finish** and **Start** it.

### 2. Install Ollama (CT 220 → Console, log in as root)

Run these one at a time:

```
apt update && apt install -y curl iptables iptables-persistent
```

(Say **Yes** to both save prompts.)

```
curl -fsSL https://ollama.com/install.sh | sh
```

Let it listen on the network, not only inside the container:

```
mkdir -p /etc/systemd/system/ollama.service.d && printf '[Service]\nEnvironment="OLLAMA_HOST=0.0.0.0:11434"\nEnvironment="OLLAMA_KEEP_ALIVE=30m"\n' > /etc/systemd/system/ollama.service.d/override.conf && systemctl daemon-reload && systemctl restart ollama
```

Download the model (about 4.7 GB, takes a few minutes):

```
ollama pull qwen2.5:7b
```

### 3. Only let CCCS talk to it

Ollama has no password, so block everyone except CCCS (CT 140, 192.168.7.54):

```
iptables -A INPUT -p tcp --dport 11434 -s 192.168.7.54 -j ACCEPT && iptables -A INPUT -p tcp --dport 11434 -s 127.0.0.1 -j ACCEPT && iptables -A INPUT -p tcp --dport 11434 -j DROP && netfilter-persistent save
```

### 4. Point CCCS at it (Proxmox host shell: `pct enter 140`)

Check CCCS can reach it. This should print a line with `qwen2.5:7b`:

```
curl -s http://192.168.7.202:11434/api/tags
```

Add the setting and restart:

```
echo 'LOCAL_AI_URL=http://192.168.7.202:11434' >> /etc/cccs/cccs.env && systemctl restart cccs
```

If you used the smaller model, also add `LOCAL_AI_MODEL=qwen2.5:3b`.

### 5. Test

On the officer app, open **Incident report**, type
`arrived 2215, rear fire door open, no one inside, secured it, rang keyholder 2230`
and press **Fill in the form from my notes**. The result says
"Written by the local AI". If it says "simple template" with a reason, that
reason says what went wrong.

## Settings (in /etc/cccs/cccs.env)

| Setting | Default | |
|---|---|---|
| `LOCAL_AI_URL` | (off) | e.g. `http://192.168.7.202:11434`. Unset = template only |
| `LOCAL_AI_MODEL` | `qwen2.5:7b` | Any Ollama model that supports structured output |
| `LOCAL_AI_TIMEOUT_MS` | `240000` | Past this, the template is used |
| `LOCAL_AI_MAX_QUEUE` | `2` | Drafts sent to the AI at once; extra ones get the template |
