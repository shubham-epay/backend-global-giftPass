const { Schema, model } = require('mongoose');
const {
  PUBLISH_STATUS, BANNER_PLACEMENTS, BANNER_TEXT_POSITIONS, BANNER_TEXT_THEMES,
} = require('../constants/enums');

const HEX_RE = /^#[0-9A-F]{6}$/i;
const { urlField, ref } = require('./_shared');

const bannerSchema = new Schema({
  title: { type: String, required: true, trim: true, maxlength: 160 },
  imageUrl: urlField({ required: true }),
  status: { type: String, enum: PUBLISH_STATUS, required: true, default: 'ACTIVE' },
  subtitle: { type: String, trim: true, maxlength: 300 },
  buttonText: { type: String, trim: true, maxlength: 40 },
  buttonLink: { type: String, trim: true, maxlength: 2048, match: [/^(https?:\/\/|\/)[^\s]*$/i, 'Link must be an http(s) URL or a site path starting with /'] },
  mobileImageUrl: urlField(),
  imageAlt: { type: String, trim: true, maxlength: 160 },
  // How the heading / text / button are laid over the image
  textPosition: { type: String, enum: BANNER_TEXT_POSITIONS, default: 'LEFT' },
  textTheme: { type: String, enum: BANNER_TEXT_THEMES, default: 'DARK' }, // DARK text for light images, LIGHT text for dark images
  buttonColor: { type: String, trim: true, uppercase: true, match: [HEX_RE, 'Use a hex colour such as #E0435A'], default: '#E0435A' },
  openInNewTab: { type: Boolean, default: false },
  placement: { type: String, enum: BANNER_PLACEMENTS, default: 'HOME_HERO' },
  sortOrder: { type: Number, default: 0 },
  startDate: Date,
  endDate: Date,
  createdBy: ref('User'),
  updatedBy: ref('User'),
}, { timestamps: true });

bannerSchema.index({ status: 1, placement: 1, sortOrder: 1 });
bannerSchema.pre('validate', function checkDates(next) {
  if (this.startDate && this.endDate && this.endDate <= this.startDate) this.invalidate('endDate', 'End date must be after start date');
  if (this.buttonText && !this.buttonLink) this.invalidate('buttonLink', 'Add a link for the button');
  if (this.buttonLink && !this.buttonText) this.invalidate('buttonText', 'Add the button text');
  next();
});

module.exports = model('Banner', bannerSchema);
