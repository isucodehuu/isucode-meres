# isucode-meres

Weboldal-mérő az IsuCode (isucode.hu) számára.

- `jeloltek/ÉÉÉÉ-HH-NN-*.json`: lemérendő nyilvános weboldalak listája (`{"sites":["https://…"]}`).
- Push után a **Weboldalak mérése** munkafolyamat 6 gépen lemér minden oldalt (Google Lighthouse mobil és asztali,
  képernyőképek, HTTPS, alap SEO-elemek), és az eredményt az `elemzes/ÉÉÉÉ-HH-NN/` mappába teszi.
- A **Levélküldés időzítő** napközben szól az isucode.hu szerverének, hogy küldje ki az adminban már jóváhagyott leveleket.

Csak nyilvános weboldalak címei és képernyőképei vannak itt olvasható formában; a mérési adatok (oldalszöveg, kapcsolati adatok) titkosítva (`.json.enc`), levelek és jelszavak nincsenek.
