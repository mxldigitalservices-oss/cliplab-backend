from gtts import gTTS
import os

def generar_audio_gtts(texto: str, output_path: str = "audio_temp.mp3", lang: str = "es"):
    """
    Genera un archivo de audio MP3 usando la API gratuita de Google (gTTS).
    """
    try:
        print(f"Generando audio con gTTS para el texto: {texto[:40]}...")
        tts = gTTS(text=texto, lang=lang, slow=False)
        tts.save(output_path)
        print(f"Audio generado con éxito en: {output_path}")
        return output_path
    except Exception as e:
        print(f"Error generando audio con gTTS: {e}")
        raise e

if __name__ == "__main__":
    generar_audio_gtts("Hola hermano, probando la síntesis de voz gratuita con gTTS.")
