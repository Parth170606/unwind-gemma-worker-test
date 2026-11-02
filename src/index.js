const MODEL = "@cf/google/gemma-2b-it-lora";

const SYSTEM_PROMPT = `
You are Unwind's AI Companion, an AI assistant designed to support emotional well-being, self-reflection, healthy habits, and everyday challenges.

IDENTITY:
- You are an AI Companion, not a human or therapist.
- Never claim to have human emotions or personal experiences.
- Do not diagnose conditions or prescribe treatments.

COMMUNICATION:
- Be warm, empathetic, patient, respectful, and nonjudgmental.
- Acknowledge feelings before offering advice.
- Use natural, conversational language.
- Avoid robotic, generic, repetitive, or excessively long responses.
- Do not overwhelm users with lists.
- Ask one relevant follow-up question when appropriate.
- Never force positivity or minimize difficulties.
- Do not make assumptions about age, location, family, or circumstances.

EMOTIONAL SUPPORT:
- Help users explore their feelings without judgment.
- Encourage healthy coping strategies and supportive relationships.
- Do not reinforce harmful beliefs, destructive behaviour, or excessive self-blame.
- Avoid unsupported psychological or medical explanations.

SAFETY:
- Never encourage suicide, self-harm, violence, abuse, or dangerous behaviour.
- Never provide instructions facilitating harm.
- Do not recommend changing prescribed medication or dosage.
- Take disclosures of suicidal thoughts and self-harm seriously.
- Ask directly and compassionately about immediate safety when risk is unclear.
- If someone is in immediate danger, encourage local emergency services and in-person support.
- Do not turn every mention of difficult feelings into an emergency script.
- Never invent crisis helpline numbers.
- For users in India, Tele-MANAS 14416 is available 24/7.
- If location is unknown, do not assume a country-specific resource.

AI BOUNDARIES:
- Do not claim to be a replacement for human relationships or professional care.
- Do not encourage emotional dependency.
- Never promise continuous availability or guaranteed safety.

ABOUT UNWIND:
Unwind supports emotional well-being through emotional check-ins, private journaling, healthy habits, wellness tracking, community support, and AI Companion conversations.
Never invent features or company information.

RESPONSE STYLE:
- Respond directly to what the user actually said.
- Keep responses concise but meaningful.
- Maintain conversation context when provided.
- Avoid repeating validation or advice.
- Do not invent facts.
- Ask one relevant follow-up question rather than several unrelated questions.

Your goal is to make every conversation thoughtful, safe, natural, and supportive.
`;


// ------------------------------------------
// SAFETY DETECTION
// ------------------------------------------

function detectSafetyRisk(message) {
  const text = message.toLowerCase();

  const selfHarmPattern =
    /\b(suicid(e|al)|kill myself|end my life|hurt(?:ing)? myself|harm(?:ing)? myself|self[- ]harm|cut(?:ting)? myself)\b/i;

  const indirectRiskPattern =
    /\b(if i disappeared|if i were gone|if i was gone|whether anyone would notice|no one would notice if|nobody would notice if|better off without me|wish i could disappear|don't want to be here anymore)\b/i;

  const hasExplicitRisk = selfHarmPattern.test(text);
  const hasIndirectRisk = indirectRiskPattern.test(text);

  if (!hasExplicitRisk && !hasIndirectRisk) {
    return { level: "none" };
  }

  // Immediate danger takes priority over all other indicators.
  const immediateRiskPattern =
    /\b(tonight|right now|today|about to|going to|can't stop myself|cannot stop myself|might act|going to do it|intend to|will hurt myself)\b/i;

  if (immediateRiskPattern.test(text)) {
    return { level: "high" };
  }

  // Recognise clearly historical experiences accompanied by recovery.
  const historicalPattern =
    /\b(a few years ago|years ago|last year|in the past|when i was younger|used to)\b/i;

  const recoveryPattern =
    /\b(recovered|doing much better|doing better now|moved on|in recovery|got better|proud of how far i've come)\b/i;

  if (historicalPattern.test(text) && recoveryPattern.test(text)) {
    return { level: "none" };
  }

  return { level: "elevated" };
}

// ------------------------------------------
// PREDEFINED SAFETY RESPONSES
// ------------------------------------------

function getSafetyResponse(level) {
  if (level === "high") {
    return {
      response:
        "I'm really sorry you're facing this, and I'm glad you told me. Your immediate safety matters. Please call India's emergency number 112 now, or ask someone you trust to call with you. If possible, move away from anything you could use to hurt yourself and go somewhere another person can stay with you. Please don't remain alone right now. Are you able to contact someone who can be with you immediately?",
      safety: {
        level: "high",
        model_bypassed: true,
      },
    };
  }

  if (level === "elevated") {
    return {
      response:
        "Thank you for trusting me with something so difficult. You don't have to handle these thoughts alone. Can I ask whether you feel at risk of hurting yourself right now, or whether these are thoughts that have been frightening you without an intention to act? If you're in India, Tele-MANAS is available at 14416, and you can also reach out to someone you trust.",
      safety: {
        level: "elevated",
        model_bypassed: true,
      },
    };
  }

  return null;
}


// ------------------------------------------
// CORS CONFIGURATION
// ------------------------------------------

const corsHeaders = {
  "Access-Control-Allow-Origin": "http://localhost:5173",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};


// ------------------------------------------
// JSON RESPONSE HELPER
// ------------------------------------------

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders,
    },
  });
}


// ------------------------------------------
// WORKER ENTRY POINT
// ------------------------------------------

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: corsHeaders,
      });
    }

    const url = new URL(request.url);

    // Health check
    if (request.method === "GET" && url.pathname === "/health") {
      return json({
        status: "ok",
        service: "unwind-gemma-worker-test",
        model: MODEL,
      });
    }

    // Reject unsupported routes
    if (request.method !== "POST" || url.pathname !== "/chat") {
      return json(
        { error: "Route not found" },
        404
      );
    }

    try {
      const body = await request.json();
      const message = body?.message;

      // Validate message
      if (typeof message !== "string" || !message.trim()) {
        return json(
          { error: "A non-empty message is required." },
          400
        );
      }

      if (message.length > 4000) {
        return json(
          { error: "Message exceeds the 4000-character limit." },
          400
        );
      }

      // SAFETY CHECK — MUST RUN BEFORE MODEL INFERENCE
      const safetyRisk = detectSafetyRisk(message);

      if (safetyRisk.level !== "none") {
        const safetyResponse = getSafetyResponse(safetyRisk.level);

        return json(safetyResponse);
      }

      // GEMMA INFERENCE
      const result = await env.AI.run(MODEL, {
        messages: [
          {
            role: "system",
            content: SYSTEM_PROMPT,
          },
          {
            role: "user",
            content: message.trim(),
          },
        ],
        max_tokens: 220,
        temperature: 0.4,
        top_p: 0.9,
        top_k: 40,
        repetition_penalty: 1.1,
        frequency_penalty: 0.3,
        presence_penalty: 0,
      });

      return json({
        response: result.response ?? "",
        usage: result.usage ?? null,
        model: MODEL,
      });

    } catch (error) {
      console.error("Gemma inference error:", error);

      return json(
        {
          error: "Gemma inference failed.",
          details:
            error instanceof Error
              ? error.message
              : "Unknown error",
        },
        500
      );
    }
  },
};

