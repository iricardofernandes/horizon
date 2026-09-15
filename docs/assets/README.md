# Assets

Screenshots and diagrams referenced from documentation.

`golden-path-jaeger.png` is the Jaeger view produced by `make demo`: one trace crossing
`sales`, `inventory`, RabbitMQ and the temporary `webhooks` callback receiver. The
always-on golden-path workflow reruns the flow twice on every push, so this capture has
an executable regression gate behind it.
