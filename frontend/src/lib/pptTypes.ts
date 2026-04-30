export type PptSlide = {
  title: string;
  bullets: string[];
};

export type PptPayload = {
  title: string;
  downloadUrl: string;
  slides: PptSlide[];
};

