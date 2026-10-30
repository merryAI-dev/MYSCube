# Onboarding walkthrough

Product route: `/guides/onboarding`. Existing admin, portal and feature-search entry points open the informational guide in a new tab, preserving any original work. MembershipPending renders the same guide inline without granting access to protected routes. Loading failures retain a way back to the membership status screen.

This is a labeled future-flow prototype, not a released self-service enrollment implementation. Current guidance remains requesting an administrator to link the verified login to the staff record and separately approve roles. No API, role policy, Firestore rule or production record changes are included.

Media is recorded from existing redesigned components with synthetic example.com identities only. The 1280×900 MP4 is 55.083 seconds: 53.086 seconds of timestamped browser frames plus a final hold. Output is 24fps; it is not a native 24fps capture claim. No interpolated UI frames or fabricated cursor paths. Korean captions and a text alternative are included. The GIF is a shortened 4× preview. Embedded video has controls and no autoplay. Provider/CDN byte-range support is required for chapter seeking.

Validation: product build; membership/auth/route tests; browser playback, seeking, speed, caption rendering, narrow viewport, FAQ and inline membership return. Reduced-motion CSS is implemented; real-device performance and OS setting tests are not claimed. New enrollment backend persistence remains unimplemented and is explicitly labeled throughout the guide.
