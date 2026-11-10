# Numbered section choices

Problem: Continuous 1/2/3 lists work, but v0.2.2 misses the equivalent numbered section headings when explanations separate them. The user asked explicitly about numeric coverage; manual probes confirmed five supported continuous forms and two missed section forms.

Approach: Reuse ordered section association for numeric headings starting at 1, preserve full titles and descriptions, and resolve explicit numeric references without changing an existing A/B/C section's nested numeric steps into choices. Support decimal/dunhao/parenthesis punctuation, prefixed headings, leading Markdown formatting and selection prompts before or after the alternatives. Keep examples, instructions, incomplete/duplicate groups, free input, withdrawn choices and size limits conservative. No new dependencies.

Verification: Add numeric positive/negative cases before implementation and observe missing section/reference cases fail. Include the actual installation message rewritten with numeric headings at the plugin delivery boundary. Run the full suite, all JavaScript syntax checks, diff checks and isolated OpenClaw loader. Obtain a bounded independent review, bump to v0.2.3, commit and push the verified repair. Do not install in production or send Telegram messages.
