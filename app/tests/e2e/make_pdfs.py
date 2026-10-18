import pymupdf
from pathlib import Path

HERE = Path(__file__).resolve().parent
(HERE / "files").mkdir(exist_ok=True)
names = [
    "(AT1) Chen, J. (2001) 'Introduction', in Mao's China and the Cold War, pp. 1-16.pdf",
    "(AT1) P1 Mao Zedong, 'On the Question of the Differentiation of the Three Worlds', 22 Feb 1974.pdf",
    "(AT2) Kirby, W. C. (1997) 'The Internationalization of China', China Quarterly 150, pp. 433-58.pdf",
]
for n, name in enumerate(names):
    doc = pymupdf.open()
    for p in range(3):
        page = doc.new_page()
        y = 80
        for line in range(18):
            page.insert_text((72, y), f"Page {p+1}, line {line+1}. The Cold War in Asia shaped Chinese foreign policy {n}.", fontsize=11)
            y += 18
    doc.save(HERE / "files" / name)
print("ok")
