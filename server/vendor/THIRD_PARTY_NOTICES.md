# Server vendor dependencies

## ws 8.22.0

Source: https://github.com/websockets/ws

Bundled in `ws.mjs` for the local Codex shared-server WebSocket connection.

Copyright (c) 2011 Einar Otto Stangvik <einaros@gmail.com>
Copyright (c) 2013 Arnout Kazemier and contributors
Copyright (c) 2016 Luigi Pinca and contributors

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## DiceBear 10.7.0 / Micah 10.6.0

DiceBear core: https://github.com/dicebear/dicebear (MIT).
Micah artwork: “Avatar Illustration System” by Micah Lanier,
https://www.figma.com/community/file/829741575478342595,
https://dribbble.com/micahlanier.
Licensed under CC BY 4.0: https://creativecommons.org/licenses/by/4.0/.
UnderControl generates and customizes these avatars offline; see the attribution in the avatar editor.

## unpdf 2.1.0 / PDF.js

Source: https://github.com/unjs/unpdf (MIT, Johann Schopplich).
Bundled in unpdf.mjs for isolated PDF text extraction. Mozilla PDF.js and decoder
licenses are retained in UNPDF_LICENSES.txt, together with the unpdf license.

## AI Elements component adaptations

Source: https://github.com/vercel/ai-elements (Apache-2.0, Copyright 2023 Vercel, Inc.).
See AI_ELEMENTS_LICENSE.txt and https://www.apache.org/licenses/LICENSE-2.0.
Conversation, Message, PromptInput, ChainOfThought, Task, Tool,
InlineCitation, Agent, ModelSelector and Attachments composition is adapted to
UnderControl's Base UI primitives and runtime data, without introducing an AI SDK transport.
