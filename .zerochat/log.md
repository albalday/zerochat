# Decision log

- 2026-10-12 M1-D1 Project memory kept in .zerochat/; CLAUDE.md (do-not-modify) and .cursorrules point only to AGENTS.md (M1-T1)
- 2026-10-12 M1-D2 .zerochat/ is versioned on dev with the work it records, may hold .md files (§9) and can sync to master without a version bump (§7) (M1-T2)
- 2026-10-13 M2-D1 Audits and fixes target local models in general (OpenAI-compatible or Ollama), never a named model: the user changes model per task; no model-specific changes such as name patterns or per-template notes (M2-T9)
- 2026-10-13 M2-D2 F-02, F-03 and F-04 closed as verified against llama.cpp: context read from meta.n_ctx of /v1/models, reasoning in reasoning_content with and without streaming, reasoning_effort "none" disables it, native tool_calls streamed with id (M2-T9)
- 2026-10-13 M2-D3 F-05 dropped and telemetry not touched: what matters is current context tokens; reasoning tokens are visible in the inspection; at most a summary in the reasoning viewer (M2-T9)
- 2026-10-13 M2-D4 F-01 wording was wrong: the inspector shows vision and reasoning as declared by the adapter and images are sent; the only fix allowed is generic, from server-declared modalities (M2-T9)
- 2026-10-13 M2-D5 The inspector reads declared vision from the model list the server already returns (input_modalities, LM Studio type, capabilities); only Ollama needs one extra request to /api/show; server data overrides the name inference (M2-T14)
- 2026-10-13 M2-D6 R-08 closed with a per-file count of reviewed innerHTML uses (test_html_sinks.js) instead of per-line patterns: robust to edits, any new use forces a review; the review found render_chart interpolating model-supplied color and values into SVG attributes, now normalized in renderChartCard with an injection test (M2-T10)
