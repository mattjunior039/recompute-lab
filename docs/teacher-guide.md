# Teacher guide: a 45-minute Recompute Lab

This lesson turns a cart of classroom devices, including old or expired ones, into one shared AI lab for a class period. Students see how AI perceives, learns, and answers questions, and how pooling many slow computers adds up. Everything runs on your own network; no student accounts, no cloud, and no photos are uploaded.

- **Grades:** written for grades 6–12. Notes for younger students are at the end.
- **Framework:** each part maps to one of the [AI4K12 "Five Big Ideas in AI"](https://ai4k12.org/) (Touretzky, Gardner-McCune, Martin & Seehorn). The mapping is ours; AI4K12 has not reviewed or endorsed Recompute.
- **You need:** one Hub computer (any laptop or desktop that can run Node.js), the Console open on it (ideally on a projector), and student devices on the **same Wi-Fi**. Phones, Chromebooks, and old laptops all work.

## Before class (once, about 20 minutes)
1. Start the Hub and open the Console (see the README quickstart). Let the models download once; after that the internet can be off.
2. Trust the Hub's certificate on the devices you'll use ([trust-certificate.md](trust-certificate.md)). If you skip this, devices still join in basic (http) mode, just slower.
3. Join each device by scanning the Console's QR code. On the Console, turn on **Setup → Demo mode** (fixed job sizes, a one-click reset, and a checklist), then click **Lab → Demo checklist → Prepare all devices**. Wait until every tile shows the image model and photos as ready.
4. On the Hub computer, click **💻 This computer computes too** if you want it to help.
5. **Setup → Start fresh** so the Impact counters start at zero for your class.

> Tip: keep devices plugged in. Recompute only computes while a device is charging (where the browser can tell), uses all cores but one, and slows down if a device gets hot. Every device has a big **STOP** button.

## Lesson plan
| Time | Part | Big Idea |
|---|---|---|
| 0–5 min | Hook: "Is this Chromebook trash?" | 5. Societal Impact |
| 5–15 min | Swarm Sort | 1. Perception · 2. Representation & Reasoning |
| 15–27 min | Teach the Swarm | 3. Learning · 5. Societal Impact |
| 27–37 min | Private Tutor | 4. Natural Interaction |
| 37–42 min | Science Sweep *or* discussion | 2. Representation & Reasoning |
| 42–45 min | Exit ticket | all five |

### 0–5 min · Hook (Societal Impact)
- Hold up the oldest device in the room. Ask: *"This one no longer gets updates. Is it trash?"*
- Explain the plan for today: we'll connect every device in the room into one AI lab, with no new hardware and nothing sent to the internet.
- Students scan the QR code on the projector. Watch the device grid fill up.

### 5–15 min · Swarm Sort (Perception; Representation & Reasoning)
1. Start **Swarm Sort** with only one device computing. Let it run for about 10 seconds and read the images/second out loud.
2. Have the rest of the class join. Watch the speed line and the **Speedup vs one device** chart climb.
3. Look at **Just labelled**: the AI's guess and its confidence for each photo.

**Talk about it**
- *Perception:* the model only sees a 224 × 224 grid of numbers. How is that different from how you see?
- *Representation:* it chooses from 1,000 fixed labels it learned from a big photo dataset. Find a wrong or funny label. Why might it be wrong?
- Why doesn't 4 devices always mean exactly 4× faster? (Network time, slower devices, coordination overhead.)

### 15–27 min · Teach the Swarm (Learning; Societal Impact)
1. Students open the **📷 Teach** tab on their devices and photograph real objects for three classes: **repairable**, **recyclable**, and **battery hazard** (for example, a cable, a cardboard box, an old phone). At least 8 photos per class across the room.
2. On the Console, click **▶ Train round**. Each device trains a small model on **its own photos only**, then sends just the model's numbers to the Hub, which averages them (this is called *federated learning*).
3. Run a few rounds. Watch accuracy per class change, and point at the **0 photos uploaded** counter.

**Talk about it**
- *Learning:* the model improves from examples, not rules someone wrote. What happens with too few photos, or photos that all look the same?
- Accuracy is measured on photos the model never trained on. Why is that important?
- *Societal Impact:* who benefits when photos never leave the device? When could this kind of AI still be unfair or wrong?
- Safety: a swollen or damaged battery is a real hazard. Don't handle damaged batteries; that's what the "battery hazard" class is for.

### 27–37 min · Private Tutor (Natural Interaction)
1. On one device, open **💬 Tutor**, load the model, and ask a question. If you can, unplug the internet first to show it really runs on the device.
2. Optionally launch **Private Tutor** on the Console to spread a whole list of class questions across devices.

**Talk about it**
- *Natural Interaction:* the tutor predicts one word-piece (token) at a time. Watch the tokens/second. Does sounding confident mean it's right? Find an answer that's wrong.
- Spreading questions across devices answers **more questions per minute**, but it does **not** make any single answer faster. Why not?
- What are the pros and cons of an AI that runs offline on your own device?

### 37–42 min · Science Sweep or discussion (Representation & Reasoning)
- **Estimate π:** devices throw hundreds of millions of random "darts" at a square and count how many land in the circle.
- **Disease-spread sweep:** devices each simulate different infection and recovery rates; the heat map shows which combinations cause big outbreaks.
- Ask: *Which jobs split well across many devices, and which don't?*

### Swap-ins for another lesson
- **Live Captions + Translate (Perception; Natural Interaction; Societal Impact):** click the **🎙️ Live Captions** card, then **🎤 Start microphone** and talk. Captions appear with a Spanish line underneath, made on the class's devices with no internet. Ask: *How far behind is the caption, and why? Who benefits from captions? What does "0 seconds of audio saved" promise, and how could you check it?*
- **Swarm Render (Representation & Reasoning):** the class draws one 8K picture together, tile by tile, each tile outlined in its device's color. Run **1 device vs all** and compare the times. Then show it on the **Wall** tab across the students' screens.
- **Use cases (Societal Impact):** open the **Use cases** tab and pick one card (library, shelter, office, art class, science class, home). Ask: *Who else has old devices and a problem these Labs could help with? What would you need to measure before promising it works?*

### 42–45 min · Exit ticket
Answer two:
1. Name one thing today's image AI *perceived* and one thing it got wrong.
2. In Teach the Swarm, what was shared with the Hub, and what never left your device?
3. Why can many slow computers beat one fast one at some jobs but not others?
4. Give one reason a school might reuse old devices instead of buying new ones, and one limitation.

## Big Ideas at a glance
| AI4K12 Big Idea | Where students see it |
|---|---|
| 1. Perception | Swarm Sort turns pixels into labels; the Teach camera; Live Captions turns sound into text |
| 2. Representation & Reasoning | 1,000 ImageNet labels and confidence scores; the 1,280-number "features" Teach the Swarm trains on; simulation parameters in Science Sweep |
| 3. Learning | Teach the Swarm rounds and held-out accuracy |
| 4. Natural Interaction | Private Tutor, streaming tokens, and its mistakes; captions and translation |
| 5. Societal Impact | Privacy ("0 photos uploaded", "0 audio saved", each device's "What my device did" panel), accessibility, device reuse and e-waste, the Use cases tab, honest limits |

## Younger students (grades 3–5)
Skip the federated-learning vocabulary. Run Swarm Sort ("more helpers, faster job") and Teach the Swarm ("we teach the computer with our own pictures, and the pictures stay here"). Have an adult run the Tutor.

## Honest limits to share with students
- Recompute speeds up **throughput** (more work per minute), not one single task.
- An old device alone is slow; the point is that many of them together are useful.
- Captions run a little behind speech, and translations can be wrong. The Console shows the measured delay.
- A student's device pauses while they use the Recompute page, and starts again after 30 seconds idle. It can't see other apps.
- Recompute only shows numbers it measured on your devices. It never guesses energy use; schools that own a plug-in power meter can enter real readings under **Benchmarks → Optional: measured watts**.
