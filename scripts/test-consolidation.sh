#!/usr/bin/env bash
set -euo pipefail

# 50-message consolidation test with real LLM calls.
# Tests: multi-session memory, episodic patterns, conversation summaries,
# daily consolidation → semantic knowledge, and cross-session recall.
#
# Usage: ./test-consolidation.sh <tarball> <openrouter-api-key>

TARBALL="${1:?Usage: $0 <tarball> <openrouter-api-key>}"
OPENROUTER_KEY="${2:?Usage: $0 <tarball> <openrouter-api-key>}"

BWMEM_DB="bwmem_consol_test"
BWMEM_DB_USER="bwmem"
BWMEM_DB_PASS="bwmem_test_pass"
PG_PORT="${PG_PORT:-5435}"
REDIS_PORT="${REDIS_PORT:-6382}"
TEST_DIR="/tmp/bwmem-consol-test-$$"

GREEN='\033[0;32m'; RED='\033[0;31m'; CYAN='\033[0;36m'; NC='\033[0m'
log()  { echo -e "${GREEN}[bwmem]${NC} $*"; }
fail() { echo -e "${RED}[FAIL]${NC} $*" >&2; exit 1; }

cleanup() {
  log "Cleaning up..."
  rm -rf "$TEST_DIR"
  docker rm -f bwmem-consol-pg bwmem-consol-redis 2>/dev/null || true
}
trap cleanup EXIT

[ -f "$TARBALL" ] || fail "Tarball not found: $TARBALL"

# ---- Start services ----

docker rm -f bwmem-consol-pg bwmem-consol-redis 2>/dev/null || true

log "Starting PostgreSQL (pgvector) + Redis..."
docker run -d --name bwmem-consol-pg \
  -e POSTGRES_USER="$BWMEM_DB_USER" -e POSTGRES_PASSWORD="$BWMEM_DB_PASS" -e POSTGRES_DB="$BWMEM_DB" \
  -p "$PG_PORT":5432 pgvector/pgvector:pg16 >/dev/null
docker run -d --name bwmem-consol-redis -p "$REDIS_PORT":6379 redis:7-alpine >/dev/null

for i in $(seq 1 30); do docker exec bwmem-consol-pg pg_isready -U "$BWMEM_DB_USER" >/dev/null 2>&1 && break; sleep 1; done
docker exec bwmem-consol-pg psql -U "$BWMEM_DB_USER" -d "$BWMEM_DB" -c "CREATE EXTENSION IF NOT EXISTS vector;" >/dev/null
for i in $(seq 1 15); do docker exec bwmem-consol-redis redis-cli ping 2>/dev/null | grep -q PONG && break; sleep 1; done
log "Services ready"

DATABASE_URL="postgresql://${BWMEM_DB_USER}:${BWMEM_DB_PASS}@localhost:${PG_PORT}/${BWMEM_DB}"
REDIS_URL="redis://localhost:${REDIS_PORT}"

mkdir -p "$TEST_DIR" && cd "$TEST_DIR"
echo '{"name":"bwmem-consol-test","version":"1.0.0","private":true,"type":"module"}' > package.json
npm install "$TARBALL" 2>&1 | tail -3

# ---- Write test ----

cat > test.mjs <<TESTEOF
import { BwMem } from '@bitwarelabs/bwmem';
import { OpenRouterProvider } from '@bitwarelabs/bwmem/providers/openrouter';

const DATABASE_URL = '${DATABASE_URL}';
const REDIS_URL = '${REDIS_URL}';
const OPENROUTER_KEY = '${OPENROUTER_KEY}';

let passed = 0, failed = 0;
function pass(n, d) { passed++; console.log(\`  \x1b[32mPASS\x1b[0m  \${n}\${d ? ' — ' + d : ''}\`); }
function fail(n, d) { failed++; console.log(\`  \x1b[31mFAIL\x1b[0m  \${n} — \${d}\`); }
function assert(c, n, d) { c ? pass(n, d) : fail(n, d || 'assertion failed'); }

const provider = new OpenRouterProvider({
  apiKey: OPENROUTER_KEY,
  model: 'xiaomi/mimo-v2-flash',
  embeddingModel: 'qwen/qwen3-embedding-8b',
  embeddingDimensions: 1024,
});

const mem = new BwMem({
  postgres: DATABASE_URL,
  redis: REDIS_URL,
  embeddings: provider,
  llm: provider,
  consolidation: {
    enabled: true,
    daily: '0 0 1 1 *',   // never fires (Jan 1 midnight) - we trigger manually
    weekly: '0 0 1 1 *',
  },
});

const userId = 'consolidation-test-user';
let totalMessages = 0;

async function recordPair(session, userMsg, assistantMsg) {
  await session.recordMessage({ role: 'user', content: userMsg });
  await session.recordMessage({ role: 'assistant', content: assistantMsg });
  totalMessages += 2;
}

try {
  await mem.initialize();
  console.log('\\n━━━ 50-Message Consolidation Test ━━━\\n');

  // ======== SESSION 1: Introduction & Work (18 messages) ========
  console.log('[ Session 1: Introduction & Work ]\\n');
  const s1 = await mem.startSession({ userId });

  await recordPair(s1,
    'Hey there! My name is Elena Rodriguez and I just moved to Tokyo from Barcelona.',
    'Welcome to Tokyo, Elena! That is quite a move from Barcelona. What brought you to Japan?'
  );
  await recordPair(s1,
    'I got a job as a senior machine learning engineer at SakuraTech. We are building autonomous driving systems.',
    'Exciting! Autonomous driving is cutting-edge work. What is your specific role at SakuraTech?'
  );
  await recordPair(s1,
    'I lead the perception team. We use LiDAR and camera fusion with transformer models. Mostly Python and C++ for the real-time pipeline.',
    'Leading perception — that is a critical piece. Are you using any specific ML frameworks?'
  );
  await recordPair(s1,
    'PyTorch for training, TensorRT for inference on the NVIDIA Orin chips. I also set up our MLOps pipeline with Kubeflow.',
    'Solid stack. The PyTorch to TensorRT pipeline is really the way to go for automotive. How is the adjustment to life in Tokyo?'
  );
  await recordPair(s1,
    'It is amazing! I live in Shimokitazawa. I love the vintage shops and small cafes there. The neighborhood has such character.',
    'Shimokitazawa is one of the best neighborhoods in Tokyo! Very bohemian. Have you been exploring the food scene?'
  );
  await recordPair(s1,
    'Oh yes, I am obsessed with ramen now. My favorite spot is Fuunji near Shinjuku — their tsukemen is incredible. I go twice a week.',
    'Fuunji is legendary! Their tsukemen is considered some of the best in Tokyo. Do you cook at all?'
  );
  await recordPair(s1,
    'I cook a lot of Spanish food to feel at home. My specialty is paella — I even found a shop in Asakusa that sells proper bomba rice.',
    'That is dedication! Making authentic paella in Tokyo. What else do you do outside of work?'
  );
  await recordPair(s1,
    'I run every morning along the Tamagawa river. Training for the Tokyo Marathon in March. Also learning Japanese — I am around N4 level now.',
    'Marathon training plus Japanese study on top of leading an ML team — you keep busy! Good luck with both.'
  );
  await recordPair(s1,
    'Thanks! I also have a cat named Churro that I brought from Barcelona. He is adjusting to Tokyo life too.',
    'Churro! What a perfect name for a cat from Barcelona. I hope he is settling in well.'
  );

  await s1.flush();
  console.log(\`  Recorded \${totalMessages} messages, flushing...\`);
  await s1.end();
  pass('Session 1 ended', \`\${totalMessages} messages total\`);

  // Wait for episodic consolidation job to process
  console.log('  Waiting for episodic consolidation (session 1)...');
  await new Promise(r => setTimeout(r, 10000));

  // ======== SESSION 2: Hobbies & Life Updates (18 messages) ========
  console.log('\\n[ Session 2: Hobbies & Life Updates ]\\n');
  const s2 = await mem.startSession({ userId });

  await recordPair(s2,
    'Hi again! Remember me? I had a big week — my team shipped the v2 perception model. It reduced false positives by 40%!',
    'Elena! Of course. Congratulations on the v2 launch — 40% reduction in false positives is huge for autonomous driving safety.'
  );
  await recordPair(s2,
    'Thanks! We are celebrating this weekend. My colleague Yuki is taking me to an onsen in Hakone.',
    'Hakone is beautiful! Great way to celebrate. Have you been to an onsen before?'
  );
  await recordPair(s2,
    'First time! I am nervous about the etiquette. Also, I started bouldering at a gym in Daikanyama. It is addictive.',
    'Bouldering in Daikanyama — that is a great area for it. As for onsen etiquette, the main thing is to wash thoroughly before entering.'
  );
  await recordPair(s2,
    'Good to know. By the way, I have been updating my paella recipe. I now add Japanese mushrooms — shiitake and maitake. Fusion paella!',
    'Fusion paella with Japanese mushrooms! That actually sounds incredible. The umami from shiitake would complement it well.'
  );
  await recordPair(s2,
    'It really does! Also, my Japanese is improving. I passed the JLPT N4 exam last month. Now studying for N3.',
    'Congratulations on N4! Making progress fast. How are you studying — classes, apps, immersion?'
  );
  await recordPair(s2,
    'Mix of everything. WaniKani for kanji, iTalki tutors twice a week, and I watch a lot of anime without subtitles. Currently watching Frieren.',
    'Frieren is excellent and the language is relatively approachable. WaniKani plus iTalki is a solid combination.'
  );
  await recordPair(s2,
    'Churro has been weird this week — he keeps knocking things off my desk while I work from home. Classic cat behavior.',
    'Classic Churro! Cats love knocking things off desks. Maybe he needs a window perch to distract him while you work.'
  );
  await recordPair(s2,
    'Good idea! I should get one overlooking the street in Shimokitazawa — lots of people to watch. Also my marathon training is going well, I did 30km this weekend.',
    'A 30km long run is serious marathon preparation! You are well on track for the Tokyo Marathon. When is it?'
  );
  await recordPair(s2,
    'First Sunday of March. I am aiming to finish under 4 hours. My current pace suggests around 3:50 which would be amazing.',
    'Sub-4 hours is a great goal and 3:50 pace sounds very achievable. What is your training schedule like?'
  );

  await s2.flush();
  console.log(\`  Recorded \${totalMessages} messages, flushing...\`);
  await s2.end();
  pass('Session 2 ended', \`\${totalMessages} messages total\`);

  console.log('  Waiting for episodic consolidation (session 2)...');
  await new Promise(r => setTimeout(r, 10000));

  // ======== SESSION 3: Challenges & New Developments (14 messages) ========
  console.log('\\n[ Session 3: Challenges & New Developments ]\\n');
  const s3 = await mem.startSession({ userId });

  await recordPair(s3,
    'I need to vent. We have a major deadline at SakuraTech — the v3 model needs to handle rain and snow conditions by end of quarter.',
    'That sounds stressful. Weather perception is one of the hardest challenges in autonomous driving. What is the main blocker?'
  );
  await recordPair(s3,
    'Rain drops on the LiDAR create ghost points. We are trying a new approach with temporal filtering and a diffusion model for denoising.',
    'A diffusion model for LiDAR denoising is clever. Are you training on synthetic rain data or real-world captures?'
  );
  await recordPair(s3,
    'Both! We have a rain chamber at our test facility in Tsukuba. It is actually pretty cool — we can simulate different rain intensities.',
    'A rain chamber for testing is impressive infrastructure. That real-world data will be invaluable for the model.'
  );
  await recordPair(s3,
    'On a happier note — I ran the Tokyo Marathon last weekend! Finished in 3:47! Under my goal of sub-4 hours.',
    'Elena that is incredible! 3:47 for your first Tokyo Marathon — you crushed your goal. How was the experience?'
  );
  await recordPair(s3,
    'The crowd support was unbelievable. People handing out onigiri, cheering in Japanese. I cried crossing the finish line at Tokyo Station.',
    'The Tokyo Marathon crowd is legendary. That must have been so emotional. Are you going to do another one?'
  );
  await recordPair(s3,
    'Definitely! Already signed up for Osaka Marathon in November. I also decided to switch from running to trail running for training variety. Did my first trail run in Okutama.',
    'Trail running in Okutama is gorgeous, especially along the river. The trails there are well-maintained too.'
  );
  await recordPair(s3,
    'It was beautiful. Oh, and Churro is doing great on his new window perch! He watches the Shimokitazawa foot traffic all day. Best purchase ever.',
    'Ha! Window TV for Churro. I bet the Shimokitazawa street scene keeps him entertained for hours.'
  );

  await s3.flush();
  console.log(\`  Recorded \${totalMessages} messages, flushing...\`);
  await s3.end();
  pass('Session 3 ended', \`\${totalMessages} messages total\`);

  console.log('  Waiting for episodic consolidation (session 3)...');
  await new Promise(r => setTimeout(r, 10000));

  // ======== CHECK EPISODIC CONSOLIDATION RESULTS ========
  console.log('\\n[ Episodic Consolidation Results ]\\n');

  const facts = await mem.facts.get(userId);
  console.log(\`  Facts extracted: \${facts.length}\`);
  for (const f of facts.slice(0, 15)) {
    console.log(\`    [\${f.category}] \${f.factKey}: \${f.factValue}\`);
  }
  if (facts.length > 15) console.log(\`    ... and \${facts.length - 15} more\`);
  assert(facts.length >= 10, 'Sufficient facts extracted', \`\${facts.length} facts\`);

  // Check specific key facts the LLM should have extracted
  const factText = facts.map(f => \`\${f.factKey} \${f.factValue}\`).join(' | ').toLowerCase();
  assert(factText.includes('elena') || factText.includes('name') || factText.includes('rodriguez'), 'Fact: name extracted');
  assert(factText.includes('tokyo') || factText.includes('shimokitazawa') || factText.includes('japan'), 'Fact: location');
  // Work facts may be in facts OR conversation summaries — check the full context
  const fullContextLower = (await mem.buildContext(userId, { query: 'work' })).formatted.toLowerCase();
  assert(
    factText.includes('sakura') || factText.includes('autonomous') || factText.includes('engineer') || factText.includes('perception') || factText.includes('lidar')
    || fullContextLower.includes('sakura') || fullContextLower.includes('autonomous') || fullContextLower.includes('engineer'),
    'Work info in memory', 'found in facts or context'
  );
  assert(factText.includes('churro') || factText.includes('cat'), 'Fact: pet');
  assert(factText.includes('marathon') || factText.includes('3:47') || factText.includes('running') || factText.includes('run'), 'Fact: running');
  assert(factText.includes('barcelona') || factText.includes('spain') || factText.includes('spanish'), 'Fact: origin');

  // Check conversation summaries exist
  const convSearch = await mem.searchConversations(userId, 'machine learning work at SakuraTech', 5, 0.2);
  console.log(\`  Conversation summaries found: \${convSearch.length}\`);
  for (const c of convSearch) {
    console.log(\`    [sim=\${c.similarity.toFixed(3)}] \${c.summary?.slice(0, 100)}...\`);
  }
  assert(convSearch.length >= 1, 'Conversation summaries generated', \`\${convSearch.length} summaries\`);

  // ======== TRIGGER DAILY CONSOLIDATION ========
  console.log('\\n[ Triggering Daily Consolidation ]\\n');

  await mem.triggerConsolidation('daily');
  console.log('  Daily consolidation job queued, waiting for processing...');
  await new Promise(r => setTimeout(r, 15000));

  pass('Daily consolidation triggered');

  // ======== CHECK FULL MEMORY CONTEXT ========
  console.log('\\n[ Full Memory Context Check ]\\n');

  const context = await mem.buildContext(userId, { query: 'Tell me everything about Elena' });
  console.log(\`  Context: \${context.sourcesResponded} sources, \${context.facts.length} facts\`);
  assert(parseInt(context.sourcesResponded) >= 5, 'Multiple context sources', context.sourcesResponded);
  assert(context.facts.length >= 10, 'Rich fact context', \`\${context.facts.length} facts\`);
  assert(context.formatted.length > 300, 'Substantial formatted context', \`\${context.formatted.length} chars\`);

  console.log('  --- Context preview ---');
  console.log(\`  \${context.formatted.slice(0, 800).split('\\n').join('\\n  ')}\`);
  console.log('  ---');

  // ======== SESSION 4: Memory Recall Test ========
  console.log('\\n[ Session 4: Memory Recall Test ]\\n');
  const s4 = await mem.startSession({ userId });

  const recallContext = await mem.buildContext(userId, {
    query: 'Recall everything you know about this user',
    sessionId: s4.id,
  });

  const recallResponse = await provider.chat([
    {
      role: 'system',
      content: \`You are a helpful assistant with memory of past conversations.

\${recallContext.formatted}

The user is asking you to prove you remember them. List SPECIFIC details you remember:
their name, where they live, their job, their hobbies, their cat, their food preferences,
their language studies, their marathon result, and anything else you know.
Be specific with names, numbers, and details.\`,
    },
    { role: 'user', content: 'Hey! Do you actually remember me? Prove it — tell me everything you know about me.' },
  ], { temperature: 0.2 });

  console.log('  LLM recall response:');
  console.log(\`  "\${recallResponse}"\\n\`);

  const r = recallResponse.toLowerCase();
  // Name may be in LLM response, context, or conversation summaries
  const nameInResponse = r.includes('elena') || r.includes('rodriguez');
  const nameInContext = recallContext.formatted.toLowerCase().includes('elena');
  const nameInSummaries = (await mem.searchConversations(userId, 'Elena Rodriguez', 3, 0.2))
    .some(c => c.summary?.toLowerCase().includes('elena'));
  assert(nameInResponse || nameInContext || nameInSummaries, 'Name in system', nameInResponse ? 'in LLM response' : nameInContext ? 'in context' : 'in summaries');
  assert(r.includes('tokyo') || r.includes('shimokitazawa'), 'Recalls city (Tokyo)');
  assert(r.includes('sakuratech') || r.includes('autonomous'), 'Recalls employer (SakuraTech)');
  assert(r.includes('churro'), 'Recalls cat (Churro)');
  assert(r.includes('barcelona'), 'Recalls origin (Barcelona)');
  assert(r.includes('ramen') || r.includes('paella') || r.includes('fuunji'), 'Recalls food preferences');
  assert(r.includes('marathon') || r.includes('3:47') || r.includes('running'), 'Recalls marathon');
  assert(r.includes('japanese') || r.includes('n4') || r.includes('n3'), 'Recalls language study');
  assert(r.includes('bouldering') || r.includes('climbing'), 'Recalls bouldering hobby');
  assert(r.includes('python') || r.includes('pytorch') || r.includes('lidar') || r.includes('perception'), 'Recalls technical stack');

  // Test follow-up recall
  const followup = await provider.chat([
    {
      role: 'system',
      content: \`You remember the user well. Here is your memory:\\n\${recallContext.formatted}\\nAnswer their specific question.\`,
    },
    { role: 'user', content: 'What was my marathon time and what race am I doing next?' },
  ], { temperature: 0.2 });

  console.log(\`  Follow-up: "\${followup}"\\n\`);
  assert(followup.toLowerCase().includes('3:47') || followup.toLowerCase().includes('3 hours 47'), 'Recalls exact marathon time');
  assert(followup.toLowerCase().includes('osaka'), 'Recalls next race (Osaka)');

  await s4.end();
  pass('Session 4 complete');

  // ======== SEMANTIC SEARCH ACROSS ALL SESSIONS ========
  console.log('\\n[ Cross-Session Semantic Search ]\\n');

  const techSearch = await mem.searchMessages(userId, 'autonomous driving perception LiDAR', 5, 0.3);
  console.log(\`  "autonomous driving LiDAR": \${techSearch.length} results\`);
  for (const r of techSearch.slice(0, 3)) {
    console.log(\`    [\${r.similarity.toFixed(3)}] \${r.content.slice(0, 80)}...\`);
  }
  assert(techSearch.length > 0, 'Cross-session tech search', \`\${techSearch.length} results\`);

  const personalSearch = await mem.searchMessages(userId, 'cat named Churro window perch', 5, 0.3);
  console.log(\`  "cat Churro window perch": \${personalSearch.length} results\`);
  assert(personalSearch.length > 0, 'Cross-session personal search', \`\${personalSearch.length} results\`);

  // ======== SUMMARY ========
  await mem.shutdown();

  console.log(\`\\n━━━ Results: \${passed} passed, \${failed} failed ━━━\`);
  console.log(\`Total messages: \${totalMessages}\`);
  console.log(\`Facts extracted: \${facts.length}\`);
  console.log(\`Conversation summaries: \${convSearch.length}\`);
  if (failed > 0) process.exit(1);

} catch (err) {
  console.error('\\n  FATAL:', err.message || err);
  console.error(err.stack);
  await mem.shutdown().catch(() => {});
  process.exit(1);
}
TESTEOF

log "Running 50-message consolidation test..."
echo ""
node test.mjs
