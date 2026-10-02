# Assets

Screenshots and diagrams referenced from documentation.

`golden-path-jaeger.png` is the Jaeger view produced by `make demo`: one trace crossing
`sales`, `inventory`, RabbitMQ and the temporary `webhooks` callback receiver. The
always-on golden-path workflow reruns the flow twice on every push, so this capture has
an executable regression gate behind it.

`readme/` holds the root README's illustrations: `hero.jpg`, `architecture.png` and
`golden-path.gif`, and `social-preview.jpg`, the hero cropped to 1280×640 for the
repository's social preview. They were generated with Higgsfield (GPT Image 2 for the stills,
Seedance 2.0 for the animation) from prompts that state every label. Each was checked
against the code before it was committed. They are drawings, not evidence: the Jaeger
capture above is the evidence. When a module, a step of the golden path or a piece of the
platform changes, regenerate them or remove them.

`modules/` holds one diagram per module README, generated the same way with the root
architecture diagram as the style reference. Each one's labels come from that module's
events, read from `docs/events.md` and its consumers' code. When a module starts or stops
publishing or consuming an event, regenerate its diagram.
