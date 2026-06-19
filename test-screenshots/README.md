# Easy Equities test screenshots

Drop your real EE holding screenshots (PNG/JPG) in this folder, then run:

    node backend/test/ee-ocr-image.mjs

It runs each image through the exact shipped OCR + parser pipeline in headless
Chrome and prints the title-bar read, the parsed name/code/shares/cost/market,
so the scanner can be tuned against real OCR output.
