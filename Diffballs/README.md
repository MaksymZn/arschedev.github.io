[***Diffballs***](https://diffballs.github.io) by [wert1x](https://github.com/wert1x),
[arschedev](https://github.com/arschedev) & [MaksymMNM](https://github.com/MaksymMNM)

Rewritten game core (`main.js`), original: [diffballs/diffballs.github.io](https://github.com/diffballs/diffballs.github.io)

- **Balls never leave the field.** Walls are the game field itself (not the whole page),
  every ball is clamped inside it after each physics step, also after the window is resized.
- **No lag with many balls.** Balls are drawn on a `<canvas>` instead of one `<div>` each
  (the old code forced a page re-layout for every ball on every frame), collisions are
  found with a spatial grid instead of checking every pair, and physics has a time budget
  per frame, so a huge crowd slows the game down a little instead of freezing it.
- **Balls don't stick.** Real elastic collisions: overlapping balls are pushed apart and
  bounce only while they move towards each other (the old code flipped the speed every
  frame while they overlapped). A new ball is placed on the nearest free spot, so a fast
  double click creates two balls side by side; a ball can be caught 0.4 s after it was created.
- Movement is time based: the fps option changes smoothness, not the speed of the balls.
